import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import { canonicalKey, parseProgram, serializeClause } from '../src/engine/index.js';

let root: string;
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rembero-test-'));
  store = new MemoryStore(root);
});

describe('MemoryStore.assert', () => {
  it('persists clauses to a readable .dl file', () => {
    const result = store.assert('default', "works_at(rahul, acme). lives_in(rahul, 'North Sydney').");
    expect(result.added).toHaveLength(2);
    expect(result.duplicates).toBe(0);
    const text = readFileSync(join(root, 'default.dl'), 'utf8');
    expect(text).toContain('works_at(rahul, acme).');
    expect(text).toContain("lives_in(rahul, 'North Sydney').");
  });

  it('deduplicates repeated facts and alpha-equivalent rules', () => {
    store.assert('default', 'works_at(rahul, acme).');
    const again = store.assert('default', 'works_at(rahul,   acme).');
    expect(again.added).toHaveLength(0);
    expect(again.duplicates).toBe(1);

    store.assert('default', 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.');
    const renamed = store.assert(
      'default',
      'colleague(A, B) :- works_at(A, C), works_at(B, C), A != B.'
    );
    expect(renamed.added).toHaveLength(0);
    expect(renamed.duplicates).toBe(1);

    store.assert(
      'default',
      'ahead(X) :- score(X, S), baseline(B), S > B + 5.'
    );
    const arithmeticRenamed = store.assert(
      'default',
      'ahead(Person) :- score(Person, Value), baseline(Base), Value > Base + 5.'
    );
    expect(arithmeticRenamed.added).toHaveLength(0);
    expect(arithmeticRenamed.duplicates).toBe(1);
  });

  it('rejects invalid namespace names', () => {
    expect(() => store.assert('../evil', 'f(a).')).toThrow(/namespace/i);
    expect(() => store.assert('no spaces', 'f(a).')).toThrow(/namespace/i);
  });

  it('rejects clauses that do not parse, leaving the store untouched', () => {
    expect(() => store.assert('default', 'works_at(X, acme).')).toThrow();
    expect(store.load('default')).toEqual([]);
  });
});

describe('MemoryStore.load', () => {
  it('round-trips what was asserted', () => {
    store.assert('default', 'parent(a, b). ancestor(X, Y) :- parent(X, Y).');
    const fresh = new MemoryStore(root);
    expect(fresh.load('default').map(serializeClause)).toEqual([
      'parent(a, b).',
      'ancestor(X, Y) :- parent(X, Y).',
    ]);
  });

  it('returns empty for a namespace that does not exist yet', () => {
    expect(store.load('brand_new')).toEqual([]);
  });

  it('fails loudly on a corrupt file, naming the file', () => {
    writeFileSync(join(root, 'broken.dl'), 'this is ( not datalog.');
    expect(() => store.load('broken')).toThrow(/broken\.dl/);
  });
});

describe('MemoryStore.retract', () => {
  beforeEach(() => {
    store.assert(
      'default',
      `works_at(rahul, acme). works_at(maya, acme). works_at(chen, initech).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`
    );
  });

  it('retracts facts matching a pattern with wildcards', () => {
    const result = store.retract('default', 'works_at(_, acme)');
    expect(result.removed).toBe(2);
    expect(store.load('default').map(serializeClause)).toEqual([
      'works_at(chen, initech).',
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    ]);
  });

  it('retracts an exact rule given in canonical form', () => {
    const result = store.retract(
      'default',
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
    );
    expect(result.removed).toBe(1);
    expect(store.load('default').map(serializeClause)).not.toContain(
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
    );
  });

  it('removes nothing when the pattern matches nothing', () => {
    expect(store.retract('default', 'works_at(nobody, _)').removed).toBe(0);
  });
});

describe('journal', () => {
  function journalLines(): { ts: string; op: string; [k: string]: unknown }[] {
    const text = readFileSync(join(root, 'journal.log'), 'utf8');
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('records asserts with the clauses added', () => {
    const result = store.assert('default', 'f(a). f(a).');
    const [entry] = journalLines();
    expect(entry.op).toBe('assert');
    expect(entry.namespace).toBe('default');
    expect(entry.added).toEqual(['f(a).']);
    expect(entry.duplicates).toBe(1);
    expect(entry.opId).toBe(result.opId);
    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(entry.ts).getTime()).not.toBeNaN();
  });

  it('records retractions with pattern and count', () => {
    store.assert('default', 'f(a). f(b).');
    store.retract('default', 'f(_)');
    const entries = journalLines();
    expect(entries[1]).toMatchObject({ op: 'retract', pattern: 'f(_)', removed: 2 });
  });

  it('records the source text of remembered statements', () => {
    store.note('default', 'remember', { text: 'Rahul works at Acme' });
    expect(journalLines()[0]).toMatchObject({
      op: 'remember',
      namespace: 'default',
      text: 'Rahul works at Acme',
    });
  });

  it('redacts credentials from source provenance before writing the journal', () => {
    const secret = 'sk-supersecretvalue';
    store.assert('default', 'uses(rahul, rembero).', {
      opId: 'sensitive-source',
      sourceText: `My API key is ${secret}`,
    });

    const journal = readFileSync(join(root, 'journal.log'), 'utf8');
    expect(journal).not.toContain(secret);
    expect(journal).toContain('[sensitive source omitted]');

    const key = canonicalKey(parseProgram('uses(rahul, rembero).')[0]);
    expect(store.sourcesFor(['default']).get(key)).toEqual([
      expect.objectContaining({
        opId: 'sensitive-source',
        text: '[sensitive source omitted]',
        redacted: true,
      }),
    ]);
  });

  it('does not journal no-op asserts', () => {
    store.assert('default', 'f(a).');
    store.assert('default', 'f(a).');
    expect(journalLines()).toHaveLength(1);
  });

  it('links current clauses to their latest durable source', () => {
    store.assert('default', 'works_at(rahul, acme).', {
      opId: 'remember-1',
      sourceText: 'Rahul works at Acme',
    });
    const key = canonicalKey(parseProgram('works_at(rahul, acme).')[0]);
    expect(store.sourcesFor(['default']).get(key)).toEqual([
      expect.objectContaining({
        namespace: 'default',
        opId: 'remember-1',
        text: 'Rahul works at Acme',
      }),
    ]);

    store.retract('default', 'works_at(rahul, _)');
    expect(store.sourcesFor(['default']).has(key)).toBe(false);
  });

  it('keeps deterministic sources for the same fact across namespaces', () => {
    store.assert('work', 'uses(rahul, rembero).', { opId: 'work-source' });
    store.assert('personal', 'uses(rahul, rembero).', { opId: 'personal-source' });
    const key = canonicalKey(parseProgram('uses(rahul, rembero).')[0]);
    expect(store.sourcesFor('*').get(key)?.map((source) => source.namespace)).toEqual([
      'personal',
      'work',
    ]);
    expect(
      store.sourcesFor(['work', 'personal']).get(key)?.map((source) => source.namespace)
    ).toEqual(['work', 'personal']);
  });

  it('fails loudly when durable provenance is corrupt', () => {
    store.assert('default', 'f(a).');
    writeFileSync(join(root, 'journal.log'), '{broken\n', 'utf8');
    expect(() => store.sourcesFor(['default'])).toThrow(/journal\.log line 1/);
  });

  it('checks journal capacity before mutating memory or its cache', () => {
    writeFileSync(join(root, 'journal.log'), 'x'.repeat(16 * 1024 * 1024), 'utf8');
    expect(() => store.assert('default', 'f(a).')).toThrow(/journal\.log would exceed/i);
    expect(store.load('default')).toEqual([]);
    expect(() => readFileSync(join(root, 'default.dl'), 'utf8')).toThrow();
  });
});

describe('round-trip hardening', () => {
  const nasty = [
    "note(a, 'it''s got ''nested'' quotes').",
    "place(x, 'New York, NY (USA)').",
    "unicode(a, 'こんにちは 🦉 café').",
    "leading_digit(a, '42nd_street').",
    "looks_like_var(a, 'X').",
    "looks_like_op(a, 'a :- b, c.').",
    "spaces(a, '  padded  ').",
    'big_num(a, 123456789.25).',
    'neg(a, -273.15).',
    `long(a, '${'x'.repeat(500)}').`,
  ];

  it.each(nasty)('survives assert → reload → query for %s', (clause) => {
    store.assert('default', clause);
    const reloaded = new MemoryStore(root).load('default');
    // canonical form may legally differ from the input (e.g. unneeded quotes
    // dropped) but must parse back to the same clause
    expect(reloaded.map(canonicalKey)).toEqual(parseProgram(clause).map(canonicalKey));
    // and a second reload round-trip stays stable
    const again = new MemoryStore(root);
    again.assert('default', clause);
    expect(again.load('default')).toHaveLength(1);
  });
});

describe('namespaces', () => {
  it('lists namespaces and merges clauses across them with *', () => {
    store.assert('work', 'works_at(rahul, acme).');
    store.assert('home', 'lives_in(rahul, sydney).');
    expect(store.listNamespaces()).toEqual(['home', 'work']);
    const merged = store.clausesFor('*').map(serializeClause).sort();
    expect(merged).toEqual(['lives_in(rahul, sydney).', 'works_at(rahul, acme).']);
    expect(store.clausesFor(['work']).map(serializeClause)).toEqual(['works_at(rahul, acme).']);
  });

  it('leaves no temp files behind after writes', () => {
    store.assert('default', 'f(a).');
    store.retract('default', 'f(a)');
    expect(readdirSync(root).filter((f) => !f.endsWith('.dl') && f !== 'journal.log')).toEqual([]);
  });

  it('does not clobber writes from another process with a stale cache', () => {
    const s1 = new MemoryStore(root);
    const s2 = new MemoryStore(root);
    s1.assert('default', 'f(a).');
    s2.load('default'); // prime s2's cache
    s1.assert('default', 'g(b).'); // another process writes
    s2.assert('default', 'h(c).'); // stale cache must reload before writing
    const clauses = new MemoryStore(root).load('default').map(serializeClause).sort();
    expect(clauses).toEqual(['f(a).', 'g(b).', 'h(c).']);
  });

  it('serializes simultaneous writers from separate processes', async () => {
    const script = `
      import { MemoryStore } from './dist/store/store.js';
      new MemoryStore(process.env.TEST_MEMORY_ROOT).assert(
        'default',
        \`concurrent(\${process.env.TEST_FACT}).\`
      );
    `;
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '--eval', script],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                TEST_MEMORY_ROOT: root,
                TEST_FACT: `writer_${index}`,
              },
              stdio: ['ignore', 'ignore', 'pipe'],
            }
          );
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`concurrent writer exited ${code}: ${stderr}`));
          });
        })
      )
    );

    expect(
      new MemoryStore(root)
        .load('default')
        .map(serializeClause)
        .sort()
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => `concurrent(writer_${index}).`).sort()
    );
  });

  it('sees facts asserted by another store instance', () => {
    const s1 = new MemoryStore(root);
    const s2 = new MemoryStore(root);
    s2.load('default');
    s1.assert('default', 'f(a).');
    expect(s2.load('default').map(serializeClause)).toEqual(['f(a).']);
  });

  it('honors REMBERO_HOME for the default root', () => {
    const home = mkdtempSync(join(tmpdir(), 'rembero-home-'));
    process.env.REMBERO_HOME = home;
    try {
      const s = new MemoryStore();
      s.assert('default', 'f(a).');
      expect(readFileSync(join(home, 'memory', 'default.dl'), 'utf8')).toContain('f(a).');
    } finally {
      delete process.env.REMBERO_HOME;
    }
  });

  it('creates the root directory on demand', () => {
    const nested = join(root, 'deep', 'memory');
    const s = new MemoryStore(nested);
    s.assert('default', 'f(a).');
    expect(readFileSync(join(nested, 'default.dl'), 'utf8')).toContain('f(a).');
  });
});
