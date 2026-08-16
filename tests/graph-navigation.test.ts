import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { explainKnowledge } from '../src/knowledge/graph.js';
import {
  MAX_GRAPH_NEIGHBOR_DEPTH,
  selectExplanationGraph,
} from '../src/knowledge/graph-navigation.js';

const family = parseProgram(`
  parent(alice, bob).
  parent(bob, carol).
  parent(carol, dan).
  ancestor(X, Y) :- parent(X, Y).
  ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
`);

describe('query-scoped graph navigation', () => {
  it('selects one result support chain without changing rows or ordering', () => {
    const full = explainKnowledge(family, 'ancestor(alice, Descendant)');
    const selected = selectExplanationGraph(full, { kind: 'result', row: 2 });

    expect(selected.rows).toEqual(full.rows);
    expect(selected.rules).toEqual(full.rules);
    expect(selected.graphSelection).toMatchObject({
      selector: { kind: 'result', row: 2 },
      originalNodeCount: full.graph.nodes.length,
      originalEdgeCount: full.graph.edges.length,
    });
    expect(selected.graph.nodes.length).toBeLessThan(full.graph.nodes.length);
    expect(selected.graph.nodes).toEqual(
      full.graph.nodes.filter((node) =>
        selected.graph.nodes.some((candidate) => candidate.id === node.id)
      )
    );
    expect(selected.graph.edges).toEqual(
      full.graph.edges.filter((edge) =>
        selected.graph.edges.some((candidate) => candidate.id === edge.id)
      )
    );
    expect(selectExplanationGraph(full, { kind: 'result', row: 2 })).toEqual(selected);
    expect(selected.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'ancestor', values: ['alice', 'carol'] }),
        expect.objectContaining({ kind: 'claim', predicate: 'parent', values: ['alice', 'bob'] }),
        expect.objectContaining({ kind: 'claim', predicate: 'parent', values: ['bob', 'carol'] }),
      ])
    );
    expect(selected.graph.nodes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'parent', values: ['carol', 'dan'] }),
      ])
    );
  });

  it('walks from a claim through every explicit alternative proof', () => {
    const explanation = explainKnowledge(
      parseProgram(`
        left(a).
        right(a).
        answer(X) :- left(X).
        answer(X) :- right(X).
      `),
      'answer(a)',
      new Map(),
      { maxProofsPerRow: 2 }
    );
    const claim = explanation.graph.nodes.find(
      (node) => node.kind === 'claim' && node.predicate === 'answer'
    );
    expect(claim).toBeDefined();

    const selected = selectExplanationGraph(explanation, {
      kind: 'support',
      nodeId: claim?.id ?? '',
    });
    expect(selected.graph.nodes.filter((node) => node.kind === 'proof')).toHaveLength(4);
    expect(
      selected.graph.edges.filter((edge) => edge.kind === 'proves' && edge.to === claim?.id)
    ).toHaveLength(2);
    expect(selected.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'left' }),
        expect.objectContaining({ kind: 'claim', predicate: 'right' }),
      ])
    );
  });

  it('returns bounded undirected neighborhoods around an entity', () => {
    const full = explainKnowledge(family, 'ancestor(alice, Descendant)');
    const alice = full.graph.nodes.find(
      (node) => node.kind === 'entity' && node.value === 'alice'
    );
    expect(alice).toBeDefined();

    const oneHop = selectExplanationGraph(full, {
      kind: 'neighbors',
      nodeId: alice?.id ?? '',
      depth: 1,
    });
    const twoHop = selectExplanationGraph(full, {
      kind: 'neighbors',
      nodeId: alice?.id ?? '',
      depth: 2,
    });
    expect(oneHop.graph.nodes.every((node) => node.kind === 'entity' || node.kind === 'claim')).toBe(true);
    expect(twoHop.graph.nodes.length).toBeGreaterThan(oneHop.graph.nodes.length);
    expect(twoHop.graphSelection.selector).toEqual({
      kind: 'neighbors',
      nodeId: alice?.id,
      depth: 2,
    });
  });

  it('preserves identity provenance and returns an honest empty slice for a missing row', () => {
    const explanation = explainKnowledge(
      parseProgram(`
        rembero_alias('Mira Patel', mira).
        rembero_entity_position(works_at, 2, 0).
        works_at('Mira Patel', acme).
      `),
      'works_at(mira, Company)',
      new Map(),
      { entityIdentity: 'canonical' }
    );
    const selected = selectExplanationGraph(explanation, { kind: 'result', row: 1 });
    expect(selected.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          projectedFrom: "works_at('Mira Patel', acme).",
        }),
        expect.objectContaining({
          kind: 'entity',
          value: 'mira',
          aliases: [expect.objectContaining({ alias: 'Mira Patel' })],
        }),
      ])
    );

    const empty = selectExplanationGraph(explanation, { kind: 'result', row: 2 });
    expect(empty.graph).toEqual({ nodes: [], edges: [] });
    expect(empty.graphSelection.focusNodeIds).toEqual([]);
  });

  it('fails closed for invalid selectors or unknown nodes', () => {
    const explanation = explainKnowledge(family, 'ancestor(alice, Descendant)');
    expect(() =>
      selectExplanationGraph(explanation, { kind: 'result', row: 0 })
    ).toThrow(/graph result row/i);
    expect(() =>
      selectExplanationGraph(explanation, {
        kind: 'neighbors',
        nodeId: 'missing',
        depth: MAX_GRAPH_NEIGHBOR_DEPTH + 1,
      })
    ).toThrow(/neighbor depth/i);
    expect(() =>
      selectExplanationGraph(explanation, { kind: 'support', nodeId: 'missing' })
    ).toThrow(/not present/i);
  });
});
