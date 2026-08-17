import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_COUNTERFACTUAL_ASSUMPTIONS,
  simulateKnowledge,
} from '../src/knowledge/counterfactual.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function storeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `rembero-counterfactual-${label}-`));
}

describe('deterministic counterfactual knowledge', () => {
  it('previews a correction with proof, hypothetical provenance, graph, and integrity impact', () => {
    const root = storeRoot('impact');
    const store = new MemoryStore(root);
    store.assert(
      'default',
      [
        'works_at(mira, acme).',
        'works_at(rahul, other).',
        'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
        ':- works_at(Person, acme), suspended(Person).',
      ].join('\n'),
      { opId: 'baseline' }
    );
    const journalBefore = readFileSync(join(root, 'journal.log'), 'utf8');
    const clausesBefore = store.clausesFor(['default']);

    const result = simulateKnowledge(store, 'colleague(mira, Who)', {
      without: ['works_at(rahul, _)'],
      assume: 'works_at(rahul, acme). suspended(rahul).',
      maxProofsPerRow: 2,
    });

    expect(result.changed).toBe(true);
    expect(result.application).toMatchObject({
      namespace: 'default',
      namespaces: ['default'],
      assumed: ['works_at(rahul, acme).', 'suspended(rahul).'],
      retracted: ['works_at(rahul, other).'],
      duplicateAssumptions: [],
      unmatchedRetractions: [],
    });
    expect(result.baseline.rows).toEqual([]);
    expect(result.candidate.rows).toMatchObject([
      { bindings: { Who: 'rahul' } },
    ]);
    expect(result.resultDelta).toMatchObject({
      added: [{ bindings: { Who: 'rahul' } }],
      removed: [],
      evidenceChanged: [],
      unchangedCount: 0,
    });
    expect(result.integrityDelta).toMatchObject({
      baseline: { status: 'consistent', violationCount: 0 },
      candidate: { status: 'violations', violationCount: 1 },
      introduced: [{ bindings: { Person: 'rahul' } }],
      resolved: [],
    });
    expect(JSON.stringify(result.integrityDelta.candidate.checks)).toContain(
      '"hypothetical":true'
    );
    expect(JSON.stringify(result.candidate)).toContain('"hypothetical":true');
    expect(
      result.candidate.graph.nodes.some(
        (node) =>
          node.kind === 'claim' &&
          node.sources?.some((source) => source.hypothetical === true)
      )
    ).toBe(true);

    expect(readFileSync(join(root, 'journal.log'), 'utf8')).toBe(journalBefore);
    expect(store.clausesFor(['default'])).toEqual(clausesBefore);
  });

  it('reports removed results and resolved violations without mutating accepted facts', () => {
    const store = new MemoryStore(storeRoot('resolved'));
    store.assert(
      'default',
      [
        'status(mira, active).',
        'status(mira, terminated).',
        ':- status(Person, active), status(Person, terminated).',
      ].join('\n'),
      { opId: 'conflict' }
    );

    const result = simulateKnowledge(store, 'status(mira, State)', {
      without: ['status(mira, terminated)'],
    });

    expect(result.candidate.rows.map((row) => row.bindings.State)).toEqual(['active']);
    expect(result.resultDelta.removed).toMatchObject([
      { bindings: { State: 'terminated' } },
    ]);
    expect(result.integrityDelta).toMatchObject({
      baseline: { status: 'violations', violationCount: 1 },
      candidate: { status: 'consistent', violationCount: 0 },
      introduced: [],
      resolved: [{ bindings: { Person: 'mira' } }],
    });
    expect(store.clausesFor(['default']).map((clause) => clause.head.predicate)).toEqual([
      'status',
      'status',
      '$integrity_constraint',
    ]);
  });

  it('models target-namespace provenance even when another namespace keeps the same fact true', () => {
    const store = new MemoryStore(storeRoot('namespace'));
    store.assert('shared', 'person(mira).', { opId: 'shared-source' });

    const result = simulateKnowledge(store, 'person(Who)', {
      namespace: 'default',
      namespaces: ['default', 'shared'],
      assume: 'person(mira).',
      maxProofsPerRow: 2,
    });

    expect(result.changed).toBe(true);
    expect(result.resultDelta).toMatchObject({
      added: [],
      removed: [],
      unchangedCount: 0,
    });
    expect(result.resultDelta.evidenceChanged).toHaveLength(1);
    expect(result.candidate.rows[0]?.proofs[0]).toMatchObject({
      sources: [{ namespace: 'default', hypothetical: true }],
      sourceAlternatives: [{ namespace: 'shared', opId: 'shared-source' }],
    });
    expect(store.clausesFor(['default'])).toEqual([]);
  });

  it('composes hypothetical facts with explicit identity and trust projections', () => {
    const store = new MemoryStore(storeRoot('projections'));
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity' }
    );
    assertTentativeFacts(store, 'default', 'works_at(mira, paused_company).', {
      opId: 'tentative',
    });

    const result = simulateKnowledge(store, 'works_at(mira, Company)', {
      assume: "works_at('Mira Patel', initech).",
      entityIdentity: 'canonical',
      trustMode: 'include_tentative',
    });

    expect(result.baseline.rows.map((row) => row.bindings.Company)).toEqual([
      'acme',
      'paused_company',
    ]);
    expect(result.resultDelta.added).toMatchObject([
      {
        bindings: { Company: 'initech' },
        proofs: [
          {
            projectedFrom: "works_at('Mira Patel', initech).",
            sources: [{ hypothetical: true }],
          },
        ],
      },
    ]);
    expect(result.baseline.rows[1]?.proofs[0]).toMatchObject({ trust: 'tentative' });
  });

  it('makes duplicates and unmatched removals explicit no-ops', () => {
    const store = new MemoryStore(storeRoot('noop'));
    store.assert('default', 'item(a).', { opId: 'item' });

    const result = simulateKnowledge(store, 'item(Value)', {
      assume: 'item(a).',
      without: ['item(missing)'],
    });

    expect(result.changed).toBe(false);
    expect(result.application).toMatchObject({
      assumed: [],
      duplicateAssumptions: ['item(a).'],
      retracted: [],
      unmatchedRetractions: ['item(missing)'],
    });
    expect(result.resultDelta).toMatchObject({
      added: [],
      removed: [],
      evidenceChanged: [],
      unchangedCount: 1,
    });
  });

  it('rejects rules, reserved metadata, invalid retractions, and oversized batches', () => {
    const store = new MemoryStore(storeRoot('validation'));
    expect(() =>
      simulateKnowledge(store, 'item(X)', {
        assume: 'derived(X) :- item(X).',
      })
    ).toThrow(/ordinary ground facts/i);
    expect(() =>
      simulateKnowledge(store, 'item(X)', {
        assume: 'rembero_alias(m, mira).',
      })
    ).toThrow(/reserved metadata/i);
    expect(() =>
      simulateKnowledge(store, 'item(X)', {
        without: ['\\+ item(a)'],
      })
    ).toThrow(/one positive fact pattern/i);
    expect(() =>
      simulateKnowledge(store, 'item(X)', {
        assume: Array.from(
          { length: MAX_COUNTERFACTUAL_ASSUMPTIONS + 1 },
          (_, index) => `item(${index}).`
        ).join('\n'),
      })
    ).toThrow(/exceed/i);
  });
});
