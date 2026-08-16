import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainKnowledge } from '../src/knowledge/graph.js';
import { parseProgram } from '../src/engine/index.js';
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

  it('exposes ordered source alternatives only when proof inspection is requested', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-source-alternatives-')));
    store.assert('work', 'uses(rahul, rembero).', { opId: 'work-source' });
    store.assert('personal', 'uses(rahul, rembero).', { opId: 'personal-source' });
    const namespaces = ['work', 'personal'];

    const result = explainKnowledge(
      store.clausesFor(namespaces),
      'uses(rahul, Tool)',
      store.sourcesFor(namespaces),
      { maxProofsPerRow: 2 }
    );

    expect(result.rows[0].proofs[0]).toMatchObject({
      sources: [expect.objectContaining({ namespace: 'work', opId: 'work-source' })],
      sourceAlternatives: [
        expect.objectContaining({ namespace: 'personal', opId: 'personal-source' }),
      ],
    });
    expect(
      result.graph.nodes.find(
        (node) => node.kind === 'claim' && node.predicate === 'uses'
      )
    ).toMatchObject({
      sourceAlternatives: [expect.objectContaining({ namespace: 'personal' })],
    });
  });

  it('projects each alternative derivation as a distinct proof instance in one graph', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-proof-alternatives-')));
    store.assert(
      'default',
      `left(a). right(a).
       answer(X) :- left(X).
       answer(X) :- right(X).`
    );

    const result = explainKnowledge(
      store.load('default'),
      'answer(a)',
      new Map(),
      { maxProofsPerRow: 2 }
    );

    expect(result.rows[0].proofs[0]).toMatchObject({ predicate: 'answer', rule: 1 });
    expect(result.rows[0].alternativeProofs).toEqual([
      [expect.objectContaining({ predicate: 'answer', rule: 2 })],
    ]);
    expect(result.graph.nodes.filter((node) => node.kind === 'proof')).toHaveLength(4);
    expect(result.graph.edges.filter((edge) => edge.kind === 'proves')).toHaveLength(4);
    expect(
      result.graph.edges.filter(
        (edge) => edge.kind === 'answers' && edge.alternative === 1
      )
    ).toHaveLength(1);
  });

  it('represents successful negation as an absence node without fake sources', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-absence-')));
    store.assert(
      'work',
      'employee(alice). employee(bob). suspended(bob). available(X) :- employee(X), \\+ suspended(X).',
      { opId: 'employment-source' }
    );

    const result = explainKnowledge(
      store.load('work'),
      'available(Person)',
      store.sourcesFor(['work'])
    );
    const absence = result.graph.nodes.find((node) => node.kind === 'absence');
    const available = result.graph.nodes.find(
      (node) => node.kind === 'claim' && node.predicate === 'available'
    );

    expect(result.rows).toEqual([
      {
        bindings: { Person: 'alice' },
        proofs: [
          expect.objectContaining({
            predicate: 'available',
            because: expect.arrayContaining([
              {
                negated: true,
                predicate: 'suspended',
                pattern: ['alice'],
                stratum: 0,
              },
            ]),
          }),
        ],
      },
    ]);
    expect(absence).toMatchObject({
      kind: 'absence',
      predicate: 'suspended',
      pattern: ['alice'],
      stratum: 0,
    });
    expect(
      result.graph.edges.some(
        (edge) => edge.kind === 'because' && edge.from === available?.id && edge.to === absence?.id
      )
    ).toBe(true);
    expect(absence).not.toHaveProperty('sources');
  });

  it('keeps arithmetic comparisons as deterministic proof filters', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-arithmetic-')));
    store.assert(
      'work',
      'score(alice, 20). baseline(team, 10). ahead(X) :- score(X, S), baseline(team, B), S > B + 5.',
      { opId: 'score-source' }
    );

    const result = explainKnowledge(
      store.load('work'),
      'ahead(Person)',
      store.sourcesFor(['work'])
    );
    expect(result.rows).toEqual([
      {
        bindings: { Person: 'alice' },
        proofs: [
          expect.objectContaining({
            predicate: 'ahead',
            because: [
              expect.objectContaining({ predicate: 'score' }),
              expect.objectContaining({ predicate: 'baseline' }),
            ],
          }),
        ],
      },
    ]);
    expect(result.rules).toEqual([
      {
        number: 1,
        clause: 'ahead(X) :- score(X, S), baseline(team, B), S > B + 5.',
      },
    ]);
    expect(new Set(result.graph.nodes.map((node) => node.kind))).toEqual(
      new Set(['result', 'claim', 'entity'])
    );
  });

  it('projects scalar aggregation through contributor rows and sourced claims', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-aggregate-')));
    store.assert('work', 'works_at(alice, acme). works_at(bob, acme).', {
      opId: 'work-source',
      sourceText: 'Alice and Bob work at Acme.',
    });

    const result = explainKnowledge(
      store.load('work'),
      'count(*) as Count where works_at(Person, acme)',
      store.sourcesFor(['work'])
    );
    const aggregate = result.graph.nodes.find((node) => node.kind === 'aggregate');

    expect(result.rows).toEqual([
      {
        bindings: { Count: '2' },
        proofs: [
          expect.objectContaining({
            aggregated: true,
            op: 'count',
            input: '*',
            as: 'Count',
            value: 2,
            contributors: [
              expect.objectContaining({
                bindings: { Person: 'alice' },
                proofs: [
                  expect.objectContaining({
                    predicate: 'works_at',
                    sources: [expect.objectContaining({ opId: 'work-source' })],
                  }),
                ],
              }),
              expect.objectContaining({ bindings: { Person: 'bob' } }),
            ],
          }),
        ],
      },
    ]);
    expect(aggregate).toMatchObject({
      kind: 'aggregate',
      op: 'count',
      value: 2,
      contributorCount: 2,
    });
    expect(
      result.graph.edges.filter(
        (edge) => edge.kind === 'input' && edge.from === aggregate?.id
      ).map((edge) => edge.position)
    ).toEqual([0, 1]);
    expect(
      result.graph.nodes.filter((node) => node.kind === 'result')
    ).toHaveLength(3);
  });

  it('marks every deterministic min/max tie as an aggregate witness', () => {
    const result = explainKnowledge(
      parseProgram('score(a, 1). score(b, 1). score(c, 2).'),
      'min(Value) as Minimum where score(Person, Value)'
    );
    const aggregate = result.graph.nodes.find((node) => node.kind === 'aggregate');
    expect(
      result.graph.edges.filter(
        (edge) => edge.kind === 'witness' && edge.from === aggregate?.id
      ).map((edge) => edge.position)
    ).toEqual([0, 1]);
  });

  it('keeps wildcard contributors distinct even when their exposed bindings match', () => {
    const result = explainKnowledge(
      parseProgram('employee(alice). employee(bob).'),
      'count(*) as Count where employee(_)'
    );
    const aggregate = result.graph.nodes.find((node) => node.kind === 'aggregate');
    const inputs = result.graph.edges.filter(
      (edge) => edge.kind === 'input' && edge.from === aggregate?.id
    );

    expect(result.rows[0].bindings).toEqual({ Count: '2' });
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((edge) => edge.to)).size).toBe(2);
    expect(
      result.graph.nodes.filter(
        (node) => node.kind === 'result' && Object.keys(node.bindings).length === 0
      )
    ).toHaveLength(2);
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
