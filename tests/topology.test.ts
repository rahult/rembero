import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import {
  analyzeKnowledgeTopology,
  MAX_TOPOLOGY_PREDICATES,
} from '../src/knowledge/topology.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function topologyStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-topology-${label}-`)));
}

describe('deterministic knowledge topology', () => {
  it('maps strata, dependency polarity, aggregates, policy, sources, and open inputs', () => {
    const store = topologyStore('complete');
    store.assert(
      'default',
      `employee(alice).
       score(alice, 20).
       eligible(X) :- employee(X), \\+ suspended(X).
       eligible_count(Count) :- count(*) as Count where eligible(Person).
       :- eligible(Person), \\+ approved(Person), score(Person, Points), Points > 10.`,
      { opId: 'topology-source' }
    );

    const result = analyzeKnowledgeTopology(
      store.clausesFor(['default']),
      store.sourcesFor(['default'])
    );

    expect(result).toMatchObject({
      predicateCount: 6,
      factCount: 2,
      ruleCount: 2,
      authoredRuleCount: 2,
      constraintCount: 1,
      openInputs: ['approved/1', 'suspended/1'],
      openNegatedInputs: ['approved/1', 'suspended/1'],
      strata: [
        { stratum: 0, predicates: ['approved/1', 'employee/1', 'score/2', 'suspended/1'] },
        { stratum: 1, predicates: ['eligible/1'] },
        { stratum: 2, predicates: ['eligible_count/1'] },
      ],
    });
    expect(result.predicates.find(({ key }) => key === 'eligible/1')).toMatchObject({
      factCount: 0,
      ruleCount: 1,
      derivedOnly: true,
      stratum: 1,
      definitionNamespaces: ['default'],
      definitionOperationCount: 1,
    });
    expect(result.predicates.find(({ key }) => key === 'suspended/1')).toMatchObject({
      openInput: true,
      negativeReferences: 1,
    });
    expect(result.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          numbers: [1],
          aggregate: false,
          sources: [expect.objectContaining({ opId: 'topology-source' })],
        }),
        expect.objectContaining({
          numbers: [2],
          aggregate: true,
        }),
      ])
    );
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'excludes',
          to: 'predicate:suspended/1',
        }),
        expect.objectContaining({
          kind: 'requires',
          to: 'predicate:eligible/1',
          aggregate: true,
        }),
        expect.objectContaining({
          kind: 'excludes',
          from: expect.stringMatching(/^constraint:/),
          to: 'predicate:approved/1',
        }),
      ])
    );
  });

  it('collapses alpha-equivalent rules while retaining authored numbers and sources', () => {
    const store = topologyStore('dedup');
    store.assert(
      'first',
      `edge(a, b).
       path(X, Y) :- edge(X, Y).
       path(X, Y) :- edge(X, Z), path(Z, Y).`,
      { opId: 'first-rules' }
    );
    store.assert('second', 'path(A, B) :- edge(A, B).', {
      opId: 'second-rule',
    });

    const result = analyzeKnowledgeTopology(
      store.clausesFor(['first', 'second']),
      store.sourcesFor(['first', 'second'])
    );

    expect(result.ruleCount).toBe(2);
    expect(result.authoredRuleCount).toBe(3);
    expect(result.rules[0]).toMatchObject({
      numbers: [1, 3],
      sources: [
        expect.objectContaining({ namespace: 'first', opId: 'first-rules' }),
        expect.objectContaining({ namespace: 'second', opId: 'second-rule' }),
      ],
    });
    expect(result.recursiveComponents).toEqual([
      expect.objectContaining({ predicates: ['path/2'], ruleNumbers: [2] }),
    ]);
    expect(result.predicates.find(({ key }) => key === 'path/2')).toMatchObject({
      recursive: true,
      ruleCount: 2,
      authoredRuleCount: 3,
    });
  });

  it('selects complete upstream and downstream influence closures', () => {
    const program = parseProgram(`
      base(a). noise(a). flag(a).
      middle(X) :- base(X).
      output(X) :- middle(X).
      unrelated(X) :- noise(X).
      :- output(X), flag(X).
    `);

    const upstream = analyzeKnowledgeTopology(program, new Map(), {
      focus: 'output',
      direction: 'upstream',
    });
    expect(upstream.predicates.map(({ key }) => key)).toEqual([
      'base/1',
      'flag/1',
      'middle/1',
      'output/1',
    ]);
    expect(upstream.rules).toHaveLength(2);
    expect(upstream.constraints).toHaveLength(1);
    expect(upstream.predicates.some(({ key }) => key === 'unrelated/1')).toBe(false);
    expect(upstream.selection).toMatchObject({
      focus: 'output/1',
      direction: 'upstream',
      originalPredicateCount: 6,
      originalRuleCount: 3,
    });

    const downstream = analyzeKnowledgeTopology(program, new Map(), {
      focus: 'base/1',
      direction: 'downstream',
    });
    expect(downstream.predicates.map(({ key }) => key)).toEqual([
      'base/1',
      'flag/1',
      'middle/1',
      'output/1',
    ]);
    expect(downstream.constraints).toHaveLength(1);
    expect(downstream.graph.edges.every((edge) =>
      downstream.graph.nodes.some((node) => node.id === edge.from) &&
      downstream.graph.nodes.some((node) => node.id === edge.to)
    )).toBe(true);
  });

  it('projects explicit identity and tentative trust before topology analysis', () => {
    const store = topologyStore('projection');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity-source' }
    );
    assertTentativeFacts(store, 'default', 'status(mira, paused).', {
      opId: 'tentative-source',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    const accepted = analyzeKnowledgeTopology(clauses, sources, {
      entityIdentity: 'canonical',
    });
    expect(accepted.predicates.map(({ key }) => key)).toEqual(['works_at/2']);
    expect(accepted.predicates[0]).toMatchObject({
      factCount: 1,
      definitionNamespaces: ['default'],
    });

    const included = analyzeKnowledgeTopology(clauses, sources, {
      entityIdentity: 'canonical',
      trustMode: 'include_tentative',
    });
    expect(included.trustMode).toBe('include_tentative');
    expect(included.predicates.map(({ key }) => key)).toEqual(['status/2', 'works_at/2']);
  });

  it('rejects ambiguous focus and fails closed above predicate limits', () => {
    const ambiguous = parseProgram('value(a). value(a, b).');
    expect(() =>
      analyzeKnowledgeTopology(ambiguous, new Map(), { focus: 'value' })
    ).toThrow(/ambiguous/i);
    expect(() =>
      analyzeKnowledgeTopology(ambiguous, new Map(), { direction: 'upstream' })
    ).toThrow(/requires a focus/i);
    const oversized = parseProgram(
      Array.from(
        { length: MAX_TOPOLOGY_PREDICATES + 1 },
        (_, index) => `predicate_${index}(value).`
      ).join('\n')
    );
    expect(() => analyzeKnowledgeTopology(oversized)).toThrow(
      /exceeded 4096 predicates/i
    );
  });

  it('handles one maximum-size recursive component without using the JS call stack', () => {
    const program = parseProgram(
      Array.from(
        { length: MAX_TOPOLOGY_PREDICATES },
        (_, index) =>
          `cycle_${index}(X) :- cycle_${
            (index + 1) % MAX_TOPOLOGY_PREDICATES
          }(X).`
      ).join('\n')
    );
    const result = analyzeKnowledgeTopology(program);
    expect(result.recursiveComponents).toHaveLength(1);
    expect(result.recursiveComponents[0]).toMatchObject({
      predicates: expect.arrayContaining(['cycle_0/1', 'cycle_4095/1']),
    });
    expect(result.recursiveComponents[0]?.predicates).toHaveLength(
      MAX_TOPOLOGY_PREDICATES
    );
  });
});
