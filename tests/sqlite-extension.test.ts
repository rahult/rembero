import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatalogDatabase } from '../src/sqlite/extension.js';

const projectRoot = resolve(import.meta.dirname, '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const sqliteLoadProbe = spawnSync('sqlite3', [':memory:'], {
  input: '.load /path/that/does/not/exist\n',
  encoding: 'utf8',
});
const hasSqliteCli =
  sqliteLoadProbe.status !== null && !sqliteLoadProbe.stderr.includes('unknown command');
let extensionPath: string;

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
    ].join('\n');
    const result = spawnSync('sqlite3', [':memory:'], {
      input: script,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      { X: 'alice', Y: 'bob' },
      { X: 'bob', Y: 'alice' },
    ]);
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

  it('fails closed for recursive, unsafe, malformed, or schema-incompatible rules', async () => {
    const database = await openDatalogDatabase(':memory:', { extensionPath });
    try {
      database.exec('CREATE TABLE edge(source TEXT, target TEXT);');
      expect(() =>
        database.datalogQuery('path(X, Y) :- edge(X, Y), path(Y, Z).')
      ).toThrow(/recursive/i);
      expect(() => database.datalogQuery('unsafe(X) :- edge(Y, Z).')).toThrow(/unbound/i);
      expect(() => database.datalogQuery('bad(X) :- edge(X).')).toThrow(/expects 2 columns/i);
      expect(() => database.datalogQuery('bad(X) :- missing(X).')).toThrow(/missing/i);
      expect(() => database.datalogQuery('not datalog')).toThrow(/expected/i);
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
