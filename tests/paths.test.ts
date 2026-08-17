import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { connectKnowledgeGraph } from '../src/knowledge/paths.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function pathStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-path-${label}-`)));
}

describe('deterministic personal knowledge graph paths', () => {
  it('returns every shortest explicit relationship path in stable order', () => {
    const store = pathStore('alternatives');
    store.assert(
      'default',
      `member(mira, club).
       member(rahul, club).
       works_at(mira, acme).
       works_at(rahul, acme).`,
      { opId: 'relationship-source' }
    );

    const result = connectKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      'mira',
      'rahul'
    );

    expect(result).toMatchObject({
      status: 'connected',
      shortestHops: 2,
      searchComplete: true,
      selection: {
        from: 'mira',
        resolvedFrom: 'mira',
        to: 'rahul',
        resolvedTo: 'rahul',
        frontierExhausted: true,
      },
    });
    expect(result.paths.map((path) => path.segments.map(({ predicate }) => predicate))).toEqual([
      ['member', 'member'],
      ['works_at', 'works_at'],
    ]);
    expect(result.paths.every((path) => path.entities[0] === 'mira')).toBe(true);
    expect(result.paths.every((path) => path.entities.at(-1) === 'rahul')).toBe(true);
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'member',
          sources: [expect.objectContaining({ opId: 'relationship-source' })],
        }),
      ])
    );
  });

  it('returns only direct paths when a shorter relationship exists', () => {
    const result = connectKnowledgeGraph(
      parseProgram(`
        knows(mira, rahul).
        member(mira, club).
        member(rahul, club).
      `),
      new Map(),
      'mira',
      'rahul'
    );

    expect(result.shortestHops).toBe(1);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({
      entities: ['mira', 'rahul'],
      segments: [
        {
          predicate: 'knows',
          from: 'mira',
          to: 'rahul',
          fromPosition: 0,
          toPosition: 1,
        },
      ],
    });
    expect(
      result.graph.nodes.some(
        (node) => node.kind === 'claim' && node.predicate === 'member'
      )
    ).toBe(false);
  });

  it('traverses a derived shortcut only with its complete deterministic proof', () => {
    const store = pathStore('derived');
    store.assert('default', 'edge(a, b).', { opId: 'edge-a-b' });
    store.assert('default', 'edge(b, c).', { opId: 'edge-b-c' });
    store.assert(
      'default',
      `reachable(X, Y) :- edge(X, Y).
       reachable(X, Y) :- edge(X, Z), reachable(Z, Y).
       node(X) :- edge(X, Y).`,
      { opId: 'reachability-rules' }
    );
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    const explicit = connectKnowledgeGraph(clauses, sources, 'a', 'c', {
      maxDepth: 2,
    });
    expect(explicit).toMatchObject({
      status: 'connected',
      shortestHops: 2,
      selection: { includeDerived: false, materializedDerivedFacts: 0 },
    });

    const derived = connectKnowledgeGraph(clauses, sources, 'a', 'c', {
      maxDepth: 2,
      includeDerived: true,
    });
    expect(derived).toMatchObject({
      status: 'connected',
      shortestHops: 1,
      includeDerived: true,
      selection: {
        includeDerived: true,
        materializedDerivedFacts: 5,
      },
      paths: [
        {
          entities: ['a', 'c'],
          segments: [
            {
              predicate: 'reachable',
              derived: true,
              rule: 2,
            },
          ],
        },
      ],
      claimProofs: [
        {
          derived: true,
          proof: {
            predicate: 'reachable',
            values: ['a', 'c'],
            rule: 2,
            because: [
              {
                predicate: 'edge',
                values: ['a', 'b'],
                sources: [expect.objectContaining({ opId: 'edge-a-b' })],
              },
              {
                predicate: 'reachable',
                values: ['b', 'c'],
                rule: 1,
                because: [
                  {
                    predicate: 'edge',
                    values: ['b', 'c'],
                    sources: [expect.objectContaining({ opId: 'edge-b-c' })],
                  },
                ],
              },
            ],
          },
        },
      ],
      rules: expect.arrayContaining([
        expect.objectContaining({
          number: 2,
          clause: 'reachable(X, Y) :- edge(X, Z), reachable(Z, Y).',
        }),
      ]),
    });
    expect(derived.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'reachable',
          values: ['a', 'c'],
          derived: true,
          rule: 2,
        }),
        expect.objectContaining({
          kind: 'claim',
          predicate: 'edge',
          values: ['a', 'b'],
          sources: [expect.objectContaining({ opId: 'edge-a-b' })],
        }),
      ])
    );
    expect(derived.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'because' }),
      ])
    );
    expect(derived.rules?.map(({ clause }) => clause)).not.toContain(
      'node(X) :- edge(X, Y).'
    );
  });

  it('carries tentative premises and closed-world absence through derived paths', () => {
    const store = pathStore('derived-trust');
    assertTentativeFacts(store, 'default', 'works_at(mira, acme).', {
      opId: 'tentative-employment',
    });
    store.assert(
      'default',
      `works_at(rahul, acme).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
       available(Person, Role) :- assigned(Person, Role), \\+ suspended(Person).`
    );
    store.assert('default', 'assigned(alice, admin).', {
      opId: 'assignment-source',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    expect(
      connectKnowledgeGraph(clauses, sources, 'mira', 'rahul', {
        includeDerived: true,
      }).status
    ).toBe('no_path');
    const tentative = connectKnowledgeGraph(clauses, sources, 'mira', 'rahul', {
      includeDerived: true,
      trustMode: 'include_tentative',
    });
    expect(tentative).toMatchObject({
      status: 'connected',
      shortestHops: 1,
      trustMode: 'include_tentative',
    });
    expect(tentative.paths).toHaveLength(2);
    expect(
      tentative.paths.every(
        (path) =>
          path.segments[0]?.predicate === 'colleague' &&
          path.segments[0]?.derived === true
      )
    ).toBe(true);
    expect(tentative.claimProofs).toHaveLength(2);
    expect(
      tentative.claimProofs?.every(({ proof }) => proof.trust === 'tentative')
    ).toBe(true);
    expect(tentative.claimProofs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proof: expect.objectContaining({
            because: expect.arrayContaining([
              expect.objectContaining({
                predicate: 'works_at',
                values: ['mira', 'acme'],
                trust: 'tentative',
              }),
            ]),
          }),
        }),
      ])
    );

    const absence = connectKnowledgeGraph(clauses, sources, 'alice', 'admin', {
      includeDerived: true,
    });
    expect(absence.paths.map((path) => path.segments[0].predicate)).toContain(
      'available'
    );
    expect(absence.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'absence',
          predicate: 'suspended',
          pattern: ['alice'],
        }),
      ])
    );
  });

  it('retains aggregate contributor evidence on a derived path claim', () => {
    const store = pathStore('derived-aggregate');
    store.assert('default', 'member(red, alice). member(red, bob).', {
      opId: 'membership-source',
    });
    store.assert(
      'default',
      'team_size(Team, Count) :- count(*) as Count where member(Team, Person).',
      { opId: 'size-rule' }
    );

    const result = connectKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      'red',
      2,
      { includeDerived: true }
    );

    expect(result).toMatchObject({
      status: 'connected',
      shortestHops: 1,
      paths: [
        {
          entities: ['red', 2],
          segments: [
            expect.objectContaining({
              predicate: 'team_size',
              derived: true,
              rule: 1,
            }),
          ],
        },
      ],
      claimProofs: [
        {
          derived: true,
          proof: {
            predicate: 'team_size',
            values: ['red', 2],
            rule: 1,
            aggregate: {
              aggregated: true,
              op: 'count',
              value: 2,
              contributors: [
                {
                  proofs: [
                    expect.objectContaining({
                      predicate: 'member',
                      values: ['red', 'alice'],
                      sources: [expect.objectContaining({ opId: 'membership-source' })],
                    }),
                  ],
                },
                {
                  proofs: [
                    expect.objectContaining({
                      predicate: 'member',
                      values: ['red', 'bob'],
                      sources: [expect.objectContaining({ opId: 'membership-source' })],
                    }),
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'aggregate', op: 'count', value: 2 }),
      ])
    );
  });

  it('distinguishes a depth-bounded miss from an exhausted disconnected component', () => {
    const clauses = parseProgram('link(a, b). link(b, c). link(c, d).');
    const bounded = connectKnowledgeGraph(clauses, new Map(), 'a', 'd', {
      maxDepth: 2,
    });
    expect(bounded).toMatchObject({
      status: 'no_path',
      shortestHops: null,
      searchComplete: false,
      selection: { frontierExhausted: false },
    });

    const connected = connectKnowledgeGraph(clauses, new Map(), 'a', 'd', {
      maxDepth: 3,
    });
    expect(connected).toMatchObject({
      status: 'connected',
      shortestHops: 3,
      searchComplete: true,
    });

    const disconnected = connectKnowledgeGraph(clauses, new Map(), 'a', 'z', {
      maxDepth: 4,
    });
    expect(disconnected).toMatchObject({
      status: 'no_path',
      searchComplete: true,
      graph: {
        edges: [],
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: 'entity', value: 'a' }),
          expect.objectContaining({ kind: 'entity', value: 'z' }),
        ]),
      },
    });
  });

  it('resolves endpoint aliases and preserves projected claim evidence', () => {
    const store = pathStore('identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(knows, 2, 0).
       rembero_entity_position(knows, 2, 1).
       knows('Mira Patel', rahul).`,
      { opId: 'identity-path' }
    );

    const result = connectKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      'Mira Patel',
      'rahul',
      { entityIdentity: 'canonical' }
    );

    expect(result).toMatchObject({
      status: 'connected',
      selection: { resolvedFrom: 'mira', resolvedTo: 'rahul' },
      paths: [{ entities: ['mira', 'rahul'] }],
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'knows',
          projectedFrom: "knows('Mira Patel', rahul).",
        }),
        expect.objectContaining({
          kind: 'entity',
          value: 'mira',
          aliases: [expect.objectContaining({ alias: 'Mira Patel' })],
        }),
      ])
    );
  });

  it('derives paths through the same position-scoped canonical identity view', () => {
    const store = pathStore('derived-identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       rembero_entity_position(colleague, 2, 0).
       rembero_entity_position(colleague, 2, 1).
       works_at('Mira Patel', acme).
       works_at(rahul, acme).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`,
      { opId: 'derived-identity-source' }
    );

    const result = connectKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      'Mira Patel',
      'rahul',
      { entityIdentity: 'canonical', includeDerived: true }
    );

    expect(result).toMatchObject({
      status: 'connected',
      shortestHops: 1,
      selection: { resolvedFrom: 'mira', resolvedTo: 'rahul' },
      paths: expect.arrayContaining([
        expect.objectContaining({
          entities: ['mira', 'rahul'],
          segments: [
            expect.objectContaining({ predicate: 'colleague', derived: true }),
          ],
        }),
      ]),
      claimProofs: expect.arrayContaining([
        expect.objectContaining({
          proof: expect.objectContaining({
            because: expect.arrayContaining([
              expect.objectContaining({
                predicate: 'works_at',
                values: ['mira', 'acme'],
                projectedFrom: "works_at('Mira Patel', acme).",
              }),
            ]),
          }),
        }),
      ]),
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'entity',
          value: 'mira',
          aliases: [expect.objectContaining({ alias: 'Mira Patel' })],
        }),
      ])
    );
  });

  it('keeps tentative connections hidden unless explicitly included', () => {
    const store = pathStore('trust');
    assertTentativeFacts(store, 'default', 'knows(mira, rahul).', {
      opId: 'tentative-path',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    expect(connectKnowledgeGraph(clauses, sources, 'mira', 'rahul')).toMatchObject({
      status: 'no_path',
      searchComplete: true,
    });
    const included = connectKnowledgeGraph(clauses, sources, 'mira', 'rahul', {
      trustMode: 'include_tentative',
    });
    expect(included).toMatchObject({
      status: 'connected',
      trustMode: 'include_tentative',
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            kind: 'claim',
            predicate: 'knows',
            trust: 'tentative',
          }),
        ]),
      },
    });
  });

  it('keeps numeric endpoints distinct and handles a zero-hop identity path', () => {
    const clauses = parseProgram("link(42, answer). link('42', text).");
    expect(connectKnowledgeGraph(clauses, new Map(), 42, 'answer').status).toBe(
      'connected'
    );
    expect(connectKnowledgeGraph(clauses, new Map(), '42', 'answer').status).toBe(
      'no_path'
    );
    expect(connectKnowledgeGraph(clauses, new Map(), 42, 42)).toMatchObject({
      status: 'connected',
      shortestHops: 0,
      paths: [{ hops: 0, entities: [42], segments: [] }],
    });
  });

  it('fails closed when shortest alternatives or traversal bounds are exceeded', () => {
    const clauses = parseProgram(
      Array.from(
        { length: 4 },
        (_, index) => `link(a, x${index}). link(x${index}, b).`
      ).join('\n')
    );
    expect(() =>
      connectKnowledgeGraph(clauses, new Map(), 'a', 'b', {
        maxDepth: 2,
        maxPaths: 3,
      })
    ).toThrow(/exceeded 3 shortest paths/i);
    expect(() =>
      connectKnowledgeGraph(clauses, new Map(), 'a', 'b', { maxDepth: 9 })
    ).toThrow(/depth must be from 1 to 8/i);
    expect(() =>
      connectKnowledgeGraph(clauses, new Map(), 'a', 'b', { maxPaths: 17 })
    ).toThrow(/limit must be from 1 to 16/i);
    expect(() =>
      connectKnowledgeGraph(clauses, new Map(), 'x'.repeat(2_049), 'b')
    ).toThrow(/path start exceeds 2048 bytes/i);
    expect(() =>
      connectKnowledgeGraph(clauses, new Map(), 'a', Number.NaN)
    ).toThrow(/numeric path end must be finite/i);
  });
});
