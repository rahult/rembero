import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import { serializeClause } from '../src/engine/index.js';

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

describe('namespaces', () => {
  it('lists namespaces and merges clauses across them with *', () => {
    store.assert('work', 'works_at(rahul, acme).');
    store.assert('home', 'lives_in(rahul, sydney).');
    expect(store.listNamespaces().sort()).toEqual(['home', 'work']);
    const merged = store.clausesFor('*').map(serializeClause).sort();
    expect(merged).toEqual(['lives_in(rahul, sydney).', 'works_at(rahul, acme).']);
    expect(store.clausesFor(['work']).map(serializeClause)).toEqual(['works_at(rahul, acme).']);
  });

  it('leaves no temp files behind after writes', () => {
    store.assert('default', 'f(a).');
    store.retract('default', 'f(a)');
    expect(readdirSync(root).filter((f) => !f.endsWith('.dl'))).toEqual([]);
  });

  it('creates the root directory on demand', () => {
    const nested = join(root, 'deep', 'memory');
    const s = new MemoryStore(nested);
    s.assert('default', 'f(a).');
    expect(readFileSync(join(nested, 'default.dl'), 'utf8')).toContain('f(a).');
  });
});
