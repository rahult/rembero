import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateQuerySpec,
  evaluateWithProof,
  parseProgram,
  parseQuery,
  parseQuerySpec,
  serializeTerm,
} from '../src/engine/index.js';
import {
  openDatalogDatabase,
  sqliteDatalogExecutionMode,
} from '../src/sqlite/extension.js';

const projectRoot = resolve(import.meta.dirname, '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const sqliteLoadProbe = spawnSync('sqlite3', [':memory:'], {
  input: '.load /path/that/does/not/exist\n',
  encoding: 'utf8',
});
const hasSqliteCli =
  sqliteLoadProbe.status !== null && !sqliteLoadProbe.stderr.includes('unknown command');
let extensionPath: string;

function portableRows(program: string, query: string): Record<string, unknown>[] {
  return evaluateQuerySpec(parseProgram(program), parseQuerySpec(query)).map((bindings) =>
    Object.fromEntries(
      Object.entries(bindings).map(([name, term]) => [
        name,
        term.type === 'atom' || term.type === 'num' ? term.value : undefined,
      ])
    )
  );
}

beforeAll(() => {
  const output = execFileSync('sh', ['native/build.sh'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  extensionPath = output.trim().split('\n').at(-1) ?? '';
  expect(existsSync(extensionPath)).toBe(true);
});

describe.skipIf(!hasSqliteCli)('SQLite loadable extension', () => {
  it('loads in stock SQLite and executes a Datalog rule over ordinary tables', () => {
    const script = [
      `.load '${extensionPath.replaceAll("'", "''")}' sqlite3_rembero_init`,
      'CREATE TABLE works_at(person TEXT, company TEXT);',
      "INSERT INTO works_at VALUES ('alice', 'acme'), ('bob', 'acme'), ('carol', 'other');",
      "SELECT datalog_query('colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.');",
      'CREATE TABLE edge(source TEXT, target TEXT);',
      "INSERT INTO edge VALUES ('a', 'b'), ('b', 'c');",
      "SELECT datalog_query('path(X, Y) :- edge(X, Y). path(X, Y) :- edge(X, Z), path(Z, Y).');",
      "SELECT datalog_explain('path(X, Y) :- edge(X, Y). path(X, Y) :- edge(X, Z), path(Z, Y).');",
    ].join('\n');
    const result = spawnSync('sqlite3', [':memory:'], {
      input: script,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const [nonrecursive, recursive, explanations] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(nonrecursive).toEqual([
      { X: 'alice', Y: 'bob' },
      { X: 'bob', Y: 'alice' },
    ]);
    expect(recursive).toEqual([
      { X: 'a', Y: 'b' },
      { X: 'b', Y: 'c' },
      { X: 'a', Y: 'c' },
    ]);
    expect(explanations[2]).toMatchObject({
      row: { X: 'a', Y: 'c' },
      proof: { rule: 2 },
    });
  });
});

describe.skipIf(nodeMajor < 22)('Rembero SQLite integration', () => {
  it('compiles and executes non-recursive Datalog through the public adapter', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE works_at(person TEXT, company TEXT);
        INSERT INTO works_at VALUES
          ('alice', 'acme'),
          ('bob', 'acme'),
          ('carol', 'other');
      `);

      const rule =
        'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.';
      expect(database.datalogSql(rule)).toBe(
        'SELECT DISTINCT t0."person" AS "X", t1."person" AS "Y" ' +
          'FROM "works_at" AS t0, "works_at" AS t1 ' +
          'WHERE t1."company" = t0."company" AND t0."person" != t1."person"'
      );
      expect(database.datalogQuery(rule)).toEqual([
        { X: 'alice', Y: 'bob' },
        { X: 'bob', Y: 'alice' },
      ]);
    } finally {
      database.close();
    }
  });

  it('evaluates recursive programs to a fixpoint with set semantics', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c'), ('c', 'd');
      `);
      const program = `
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `;

      expect(database.datalogQuery(program)).toEqual([
        { X: 'a', Y: 'b' },
        { X: 'b', Y: 'c' },
        { X: 'c', Y: 'd' },
        { X: 'a', Y: 'c' },
        { X: 'b', Y: 'd' },
        { X: 'a', Y: 'd' },
      ]);
    } finally {
      database.close();
    }
  });

  it('terminates recursive cycles after deriving each tuple once', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'a');
      `);
      const rows = database.datalogQuery(`
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `);
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(
        expect.arrayContaining([
          { X: 'a', Y: 'a' },
          { X: 'a', Y: 'b' },
          { X: 'b', Y: 'a' },
          { X: 'b', Y: 'b' },
        ])
      );
    } finally {
      database.close();
    }
  });

  it('uses delta evaluation for rules with multiple recursive body literals', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c'), ('c', 'd');
      `);
      const rows = database.datalogQuery(`
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- path(X, Z), path(Z, Y).
      `);
      expect(rows).toHaveLength(6);
      expect(rows).toContainEqual({ X: 'a', Y: 'd' });
    } finally {
      database.close();
    }
  });

  it('applies constants and comparisons during recursive rounds', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE seed(node TEXT);
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO seed VALUES ('a');
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c'), ('b', 'blocked');
      `);
      expect(
        database.datalogQuery(`
          reachable(Y) :- seed(Y).
          reachable(Y) :- reachable(X), edge(X, Y), Y != blocked.
        `)
      ).toEqual([{ Y: 'a' }, { Y: 'b' }, { Y: 'c' }]);
    } finally {
      database.close();
    }
  });

  it('preserves SQLite affinity semantics when recursion is enabled', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE text_seed(value TEXT);
        CREATE TABLE numeric_seed(value INTEGER);
        INSERT INTO text_seed VALUES ('10'), ('2'), ('x');
        INSERT INTO numeric_seed VALUES (10);
      `);
      const directComparison = database.datalogQuery('out(X) :- text_seed(X), X > 2.');
      const recursiveComparison = database.datalogQuery(`
        out(X) :- text_seed(X), X > 2.
        out(X) :- out(X).
      `);
      expect(recursiveComparison).toEqual(directComparison);
      expect(recursiveComparison).toEqual([{ X: 'x' }]);

      const directJoin = database.datalogQuery(
        'matches(X) :- text_seed(X), numeric_seed(X).'
      );
      const recursiveJoin = database.datalogQuery(`
        matches(X) :- text_seed(X), numeric_seed(X).
        matches(X) :- matches(X).
      `);
      expect(recursiveJoin).toEqual(directJoin);
      expect(recursiveJoin).toEqual([{ X: '10' }]);
    } finally {
      database.close();
    }
  });

  it('compares finite numeric literals beyond int64 range like SQLite', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE big(value INTEGER);
        INSERT INTO big VALUES (9223372036854775807);
      `);
      const high = `
        high(X) :- big(X), X >= 9223372036854775808.
        high(X) :- high(X).
      `;
      const low = `
        low(X) :- big(X), X < 9223372036854775808.
        low(X) :- low(X).
      `;
      expect(database.datalogQuery(high)).toEqual(
        database.datalogQuery('high(X) :- big(X), X >= 9223372036854775808.')
      );
      expect(database.datalogQuery(low)).toEqual(
        database.datalogQuery('low(X) :- big(X), X < 9223372036854775808.')
      );
      expect(database.datalogQuery(low)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('deduplicates NULL-bearing seed tuples under recursive set semantics', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES (NULL, 'b'), (NULL, 'b');
      `);
      expect(
        database.datalogQuery(`
          path(X, Y) :- edge(X, Y).
          path(X, Y) :- edge(X, Z), path(Z, Y).
        `)
      ).toEqual([{ X: null, Y: 'b' }]);
    } finally {
      database.close();
    }
  });

  it('returns a nested derivation proof for recursive results', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c'), ('c', 'd');
      `);
      const explanations = database.datalogExplain(`
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `);
      const explanation = explanations.find(
        ({ row }) => row.X === 'a' && row.Y === 'd'
      );

      expect(explanation).toEqual({
        row: { X: 'a', Y: 'd' },
        proof: {
          predicate: 'path',
          values: ['a', 'd'],
          rule: 2,
          because: [
            { predicate: 'edge', values: ['a', 'b'] },
            {
              predicate: 'path',
              values: ['b', 'd'],
              rule: 2,
              because: [
                { predicate: 'edge', values: ['b', 'c'] },
                {
                  predicate: 'path',
                  values: ['c', 'd'],
                  rule: 1,
                  because: [{ predicate: 'edge', values: ['c', 'd'] }],
                },
              ],
            },
          ],
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps TypeScript and SQLite first-witness recursive proofs structurally aligned', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    const rules = `
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;
    try {
      database.exec(`
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c'), ('c', 'd');
      `);
      const sqliteProof = database
        .datalogExplain(rules)
        .find(({ row }) => row.X === 'a' && row.Y === 'd')?.proof;
      const typescript = evaluateWithProof(
        parseProgram(`edge(a, b). edge(b, c). edge(c, d). ${rules}`),
        parseQuery('path(a, Y)')
      ).find(({ bindings }) => serializeTerm(bindings.Y) === 'd');

      expect(typescript?.proofs[0]).toEqual(sqliteProof);
    } finally {
      database.close();
    }
  });

  it('supports constants, numbers, repeated variables, and quoted strings safely', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE score(person TEXT, team TEXT, points INTEGER);
        INSERT INTO score VALUES
          ('alice', 'red', 8),
          ('bob', 'red', 12),
          ('mallory', 'red'' OR 1=1 --', 99);
      `);

      expect(database.datalogQuery('high_scorer(X) :- score(X, red, P), P >= 10.')).toEqual([
        { X: 'bob' },
      ]);
      expect(
        database.datalogQuery("literal(X) :- score(X, 'red'' OR 1=1 --', 99).")
      ).toEqual([{ X: 'mallory' }]);
      expect(database.datalogQuery('same(X) :- score(X, X, P).')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('bridges advanced portable query semantics over referenced SQLite tables', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE employee(person TEXT);
        CREATE TABLE suspended(person TEXT);
        CREATE TABLE score(person TEXT, points INTEGER);
        CREATE TABLE baseline(team TEXT, points INTEGER);
        INSERT INTO employee VALUES ('bob'), ('alice');
        INSERT INTO suspended VALUES ('bob');
        INSERT INTO score VALUES ('alice', 20), ('bob', 14);
        INSERT INTO baseline VALUES ('team', 10);
      `);

      expect(sqliteDatalogExecutionMode('available(X) :- employee(X), \\+ suspended(X).'))
        .toBe('portable');
      expect(sqliteDatalogExecutionMode('employee(X)')).toBe('portable');
      expect(sqliteDatalogExecutionMode('copy(X) :- employee(X).')).toBe('native');

      expect(
        database.datalogQuery('available(X) :- employee(X), \\+ suspended(X).')
      ).toEqual([{ X: 'alice' }]);
      expect(
        database.datalogQuery(
          'ahead(X) :- score(X, S), baseline(team, B), S > B + 5.'
        )
      ).toEqual([{ X: 'alice' }]);
      expect(database.datalogQuery('employee(X), \\+ suspended(X)')).toEqual([
        { X: 'alice' },
      ]);
      expect(
        database.datalogQuery('count(*) as Count where employee(Person)')
      ).toEqual([{ Count: 2 }]);

      const explained = database.datalogExplain(
        'available(X) :- employee(X), \\+ suspended(X).'
      );
      expect(explained[0]).toMatchObject({
        row: { X: 'alice' },
        proof: {
          predicate: 'available',
          because: [
            { predicate: 'employee', values: ['alice'] },
            { negated: true, predicate: 'suspended', pattern: ['alice'] },
          ],
        },
      });
      expect(
        database.datalogExplain('count(*) as Count where employee(Person)')[0]
      ).toMatchObject({
        row: { Count: 2 },
        proof: { aggregated: true, op: 'count', value: 2 },
      });
    } finally {
      database.close();
    }
  });

  it('matches the portable engine for negation, arithmetic, and aggregate queries', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    const facts = `
      employee(alice). employee(bob). suspended(bob).
      score(alice, 20). score(bob, 14). baseline(team, 10).
    `;
    try {
      database.exec(`
        CREATE TABLE employee(person TEXT);
        CREATE TABLE suspended(person TEXT);
        CREATE TABLE score(person TEXT, points INTEGER);
        CREATE TABLE baseline(team TEXT, points INTEGER);
        INSERT INTO employee VALUES ('bob'), ('alice');
        INSERT INTO suspended VALUES ('bob');
        INSERT INTO score VALUES ('bob', 14), ('alice', 20);
        INSERT INTO baseline VALUES ('team', 10);
      `);
      for (const query of [
        'employee(X), \\+ suspended(X)',
        'score(X, S), baseline(team, B), S > B + 5',
        'count(*) as Count where employee(Person)',
      ]) {
        expect(database.datalogQuery(query)).toEqual(portableRows(facts, query));
      }
    } finally {
      database.close();
    }
  });

  it('uses the first rule head as the result relation for multi-predicate fixpoints', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE seed(node TEXT);
        CREATE TABLE edge(source TEXT, target TEXT);
        INSERT INTO seed VALUES ('a');
        INSERT INTO edge VALUES ('a', 'b'), ('b', 'c');
      `);
      const program = `
        answer(X) :- reachable(X), X != a.
        reachable(X) :- seed(X).
        reachable(Y) :- reachable(X), edge(X, Y).
      `;
      expect(sqliteDatalogExecutionMode(program)).toBe('portable');
      expect(database.datalogQuery(program)).toEqual([
        { X: 'b' },
        { X: 'c' },
      ]);
      expect(database.datalogExplain(program)[1]).toMatchObject({
        row: { X: 'c' },
        proof: {
          predicate: 'answer',
          because: [{ predicate: 'reachable', values: ['c'] }],
        },
      });
    } finally {
      database.close();
    }
  });

  it('orders portable-bridge facts deterministically rather than trusting table scan order', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE employee(person TEXT);
        CREATE TABLE suspended(person TEXT);
        INSERT INTO employee VALUES ('zoe'), ('alice'), ('mira');
      `);
      const query = 'employee(X), \\+ suspended(X)';
      const first = database.datalogQuery(query);
      database.exec(`
        DELETE FROM employee;
        INSERT INTO employee VALUES ('mira'), ('zoe'), ('alice');
      `);
      expect(database.datalogQuery(query)).toEqual(first);
      expect(first).toEqual([{ X: 'alice' }, { X: 'mira' }, { X: 'zoe' }]);
    } finally {
      database.close();
    }
  });

  it('fails closed when advanced evaluation encounters values outside portable Datalog', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE nullable(value INTEGER);
        CREATE TABLE binary_value(value BLOB);
        INSERT INTO nullable VALUES (NULL);
        INSERT INTO binary_value VALUES (x'00ff');
      `);
      expect(() => database.datalogQuery('nullable(X), X = X + 0')).toThrow(
        /NULL.*portable SQLite bridge/i
      );
      expect(() => database.datalogQuery('binary_value(X), X = X')).toThrow(
        /BLOB.*portable SQLite bridge/i
      );
    } finally {
      database.close();
    }
  });

  it('fails closed for unsafe, malformed, or schema-incompatible rules', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec('CREATE TABLE edge(source TEXT, target TEXT);');
      expect(() => database.datalogQuery('unsafe(X) :- edge(Y, Z).')).toThrow(/unbound/i);
      expect(() => database.datalogQuery('bad(X) :- edge(X).')).toThrow(/expects 2 columns/i);
      expect(() => database.datalogQuery('bad(X) :- missing(X).')).toThrow(/missing/i);
      expect(() => database.datalogQuery('not datalog')).toThrow(/expected/i);
      expect(() =>
        database.datalogSql('allowed(X) :- edge(X, Y), \\+ blocked(Y).')
      ).toThrow(/negation.*cannot be compiled to one SQLite SELECT/i);
      expect(() =>
        database.datalogSql('count(*) as Count where edge(X, Y)')
      ).toThrow(/aggregation.*cannot be compiled to one SQLite SELECT/i);
      expect(() =>
        database.datalogSql('ahead(X) :- edge(X, Y), Y > X + 5.')
      ).toThrow(/arithmetic.*cannot be compiled to one SQLite SELECT/i);
      expect(() =>
        database.datalogQuery('rembero_alias(mira_patel, mira).')
      ).toThrow(/entity identity.*portable Datalog engine, not the SQLite extension/i);
      expect(() =>
        database.datalogQuery('rembero_entity_position(edge, 2, 0).')
      ).toThrow(/entity identity.*portable Datalog engine, not the SQLite extension/i);
      expect(() => database.datalogQuery(':- edge(X, Y), X = Y.')).toThrow(
        /integrity constraints.*personal knowledge store/i
      );
      expect(() => database.datalogQuery('missing(X), \\+ edge(X, X)')).toThrow(
        /predicate 'missing' is unavailable/i
      );
      expect(database.datalogQuery('safe(X) :- edge(X, Y), -1 < 0.')).toEqual([]);
      expect(
        database.datalogQuery("safe(X) :- edge(X, Y), X = 'count(*) as Count where'.")
      ).toEqual([]);
      expect(
        database.datalogQuery("safe(X) :- edge(X, Y), X = 'Y + 5'.")
      ).toEqual([]);
      expect(() => database.datalogQuery('bad(X) :- edge(X, Y), X > 1e999.')).toThrow(
        /out of range/i
      );
      expect(() =>
        database.datalogQuery(`
          path(X, Y) :- edge(X, Y).
          path(X, Y) :- path(X), edge(X, Y).
        `)
      ).toThrow(/inconsistent arity/i);
      expect(() =>
        database.datalogQuery(`
          path(X, Y) :- edge(X, Y).
          path(X, Y) :- path(X, Z), edge(Z, Y), Q != blocked.
        `)
      ).toThrow(/comparison variable 'Q' is unbound/i);
    } finally {
      database.close();
    }
  });

  it('rejects an oversized single row before serializing it into the result', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE payload(value BLOB);
        INSERT INTO payload VALUES (zeroblob(9 * 1024 * 1024));
      `);
      expect(() => database.datalogQuery('result(X) :- payload(X).')).toThrow(/16 MiB/i);
    } finally {
      database.close();
    }
  });

  it('bounds recursive join work even when no new facts are emitted', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec(`
        CREATE TABLE seed(value INTEGER);
        CREATE TABLE candidate(value INTEGER);
        WITH RECURSIVE n(x) AS (
          VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000
        ) INSERT INTO seed SELECT x FROM n;
        WITH RECURSIVE n(x) AS (
          VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 11000
        ) INSERT INTO candidate SELECT x FROM n;
      `);
      expect(() =>
        database.datalogQuery(`
          keep(X) :- seed(X).
          keep(X) :- keep(X), candidate(Y), Y != Y.
        `)
      ).toThrow(/tuple checks/i);
    } finally {
      database.close();
    }
  });

  it('runs the complete database → extension → CLI path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rembero-sqlite-e2e-'));
    const databasePath = join(directory, 'world.db');
    const database = await openDatalogDatabase(databasePath, { extensionPath });
    try {
      database.exec(`
        CREATE TABLE works_at(person TEXT, company TEXT);
        INSERT INTO works_at VALUES ('alice', 'acme'), ('bob', 'acme');
      `);
    } finally {
      database.close();
    }

    try {
      const result = spawnSync(
        process.execPath,
        [
          'dist/cli.js',
          'sqlite-query',
          databasePath,
          'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
          '--extension',
          extensionPath,
        ],
        { cwd: projectRoot, encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { X: 'alice', Y: 'bob' },
        { X: 'bob', Y: 'alice' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
