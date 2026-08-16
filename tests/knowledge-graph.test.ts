import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainKnowledge } from '../src/knowledge/graph.js';
import { MemoryStore } from '../src/store/store.js';

const program = `
  parent(alice, bob).
  parent(bob, carol).
  parent(carol, dan).
  ancestor(X, Y) :- parent(X, Y).
  ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
`;

function seededStore(): MemoryStore {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-graph-')));
  store.assert('personal', program, {
    opId: 'remember-family-tree',
    sourceText: 'Alice is Bob’s parent, Bob is Carol’s parent, and Carol is Dan’s parent.',
  });
  return store;
}

describe('explainable personal knowledge graph', () => {
  it('returns recursive proofs, durable sources, rules, and deterministic graph IDs', () => {
    const store = seededStore();
    const explain = () =>
      explainKnowledge(
        store.clausesFor(['personal']),
        'ancestor(alice, Descendant)',
        store.sourcesFor(['personal'])
      );

    const result = explain();
    expect(result.rows.map((row) => row.bindings)).toEqual([
      { Descendant: 'bob' },
      { Descendant: 'carol' },
      { Descendant: 'dan' },
    ]);
    expect(result.rules).toEqual([
      { number: 1, clause: 'ancestor(X, Y) :- parent(X, Y).' },
      { number: 2, clause: 'ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).' },
    ]);

    const carol = result.rows.find((row) => row.bindings.Descendant === 'carol');
    expect(carol?.proofs).toEqual([
      {
        predicate: 'ancestor',
        values: ['alice', 'carol'],
        rule: 2,
        because: [
          {
            predicate: 'parent',
            values: ['alice', 'bob'],
            sources: [
              expect.objectContaining({
                namespace: 'personal',
                opId: 'remember-family-tree',
              }),
            ],
          },
          {
            predicate: 'ancestor',
            values: ['bob', 'carol'],
            rule: 1,
            because: [
              {
                predicate: 'parent',
                values: ['bob', 'carol'],
                sources: [
                  expect.objectContaining({
                    namespace: 'personal',
                    opId: 'remember-family-tree',
                  }),
                ],
              },
            ],
          },
        ],
      },
    ]);

    const derivedClaim = result.graph.nodes.find(
      (node) =>
        node.kind === 'claim' &&
        node.predicate === 'ancestor' &&
        node.values[0] === 'alice' &&
        node.values[1] === 'carol'
    );
    expect(derivedClaim).toMatchObject({ kind: 'claim', derived: true, rule: 2 });
    expect(
      result.graph.edges.filter(
        (edge) => edge.kind === 'because' && edge.from === derivedClaim?.id
      ).map((edge) => edge.position).sort()
    ).toEqual([0, 1]);
    expect(explain()).toEqual(result);
  });

  it('preserves arbitrary-arity claims as positional hyperedges', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-hypergraph-')));
    store.assert('default', 'meeting(alice, bob, melbourne).');
    const result = explainKnowledge(store.load('default'), 'meeting(alice, Person, City)');
    const claim = result.graph.nodes.find((node) => node.kind === 'claim');
    expect(result.rows[0].bindings).toEqual({ City: 'melbourne', Person: 'bob' });
    expect(
      result.graph.edges
        .filter((value) => value.kind === 'arg' && value.from === claim?.id)
        .map((value) => value.position)
    ).toEqual([0, 1, 2]);
  });

  it('attaches only the source for the first namespace witness', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-witness-')));
    store.assert('work', 'uses(rahul, rembero).', { opId: 'work-source' });
    store.assert('personal', 'uses(rahul, rembero).', { opId: 'personal-source' });
    const namespaces = ['work', 'personal'];

    const result = explainKnowledge(
      store.clausesFor(namespaces),
      'uses(rahul, Tool)',
      store.sourcesFor(namespaces)
    );

    expect(result.rows[0].proofs[0].sources).toEqual([
      expect.objectContaining({ namespace: 'work', opId: 'work-source' }),
    ]);
  });

  it('exposes the same graph through the built CLI', () => {
    const home = mkdtempSync(join(tmpdir(), 'rembero-graph-cli-'));
    const store = new MemoryStore(join(home, 'memory'));
    store.assert('personal', program, { opId: 'cli-source', sourceText: 'Family tree' });
    const output = execFileSync(
      process.execPath,
      [resolve('dist/cli.js'), 'explain', 'ancestor(alice, X)', '--namespaces', 'personal'],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    const result = JSON.parse(output);
    expect(result.rows.map((row: { bindings: { X: string } }) => row.bindings.X)).toEqual([
      'bob',
      'carol',
      'dan',
    ]);
    expect(result.graph.nodes.some((node: { kind: string }) => node.kind === 'claim')).toBe(true);
  });
});
