import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffRecordedKnowledge,
  MAX_RECORDED_DIFF_CHANGES,
} from '../src/knowledge/recorded-diff.js';
import {
  assertTentativeFacts,
  resolveTentativeFacts,
} from '../src/knowledge/trust-store.js';
import {
  MAX_RECORDED_SNAPSHOT_BATCH,
  MemoryStore,
} from '../src/store/store.js';

function diffStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-diff-${label}-`)));
}

describe('exact recorded knowledge diff', () => {
  it('connects clause, topology, integrity, and query consequences across sequences', () => {
    const store = diffStore('impact');
    store.assert(
      'default',
      `status(mira, active).
       employee(mira).
       eligible(X) :- employee(X), \\+ suspended(X).
       :- status(Person, active), status(Person, terminated).`,
      { opId: 'baseline' }
    );
    store.assert(
      'default',
      `status(mira, terminated).
       suspended(mira).
       badge(mira).
       badge_holder(X) :- badge(X).`,
      { opId: 'change' }
    );

    const result = diffRecordedKnowledge(store, 1, 2, {
      query: 'eligible(mira)',
      maxProofsPerRow: 2,
    });

    expect(result).toMatchObject({
      changed: true,
      from: { sequence: 1, journalEntries: 2, namespaces: ['default'] },
      to: { sequence: 2, journalEntries: 2, namespaces: ['default'] },
      journalEntriesTraversed: 1,
      clauses: {
        added: [
          { kind: 'fact', clause: 'badge(mira).', sources: [{ opId: 'change' }] },
          { kind: 'fact', clause: 'status(mira, terminated).' },
          { kind: 'fact', clause: 'suspended(mira).' },
          { kind: 'rule', clause: 'badge_holder(X) :- badge(X).' },
        ],
        removed: [],
        sourceChanged: [],
      },
      topology: {
        before: { predicateCount: 4, factCount: 2, ruleCount: 1 },
        after: { predicateCount: 6, factCount: 5, ruleCount: 2 },
        openNegatedInputsRemoved: ['suspended/1'],
      },
      integrity: {
        before: { status: 'consistent', violationCount: 0 },
        after: { status: 'violations', violationCount: 1 },
        introduced: [{ bindings: { Person: 'mira' } }],
        resolved: [],
      },
      queryImpact: {
        query: 'eligible(mira)',
        before: { rows: [{ bindings: {} }] },
        after: { rows: [] },
        added: [],
        removed: [{ bindings: {} }],
        evidenceChanged: [],
        unchangedCount: 0,
      },
    });
    expect(result.topology.addedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'predicate', key: 'badge/1' }),
        expect.objectContaining({ kind: 'predicate', key: 'badge_holder/1' }),
        expect.objectContaining({ kind: 'rule', clause: 'badge_holder(X) :- badge(X).' }),
      ])
    );
    expect(result.topology.changedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: expect.objectContaining({ key: 'suspended/1', openInput: true }),
          after: expect.objectContaining({ key: 'suspended/1', openInput: false }),
        }),
      ])
    );
    expect(result.integrity.introduced[0]?.row.proofs).toHaveLength(2);
  });

  it('reports removals and resolved policy violations', () => {
    const store = diffStore('resolved');
    store.assert(
      'default',
      'status(mira, active). status(mira, terminated). :- status(P, active), status(P, terminated).',
      { opId: 'conflict' }
    );
    store.retract('default', 'status(mira, terminated)', { opId: 'repair' });

    const result = diffRecordedKnowledge(store, 1, 2);
    expect(result.clauses.removed).toMatchObject([
      {
        kind: 'fact',
        clause: 'status(mira, terminated).',
        sources: [{ opId: 'conflict' }],
      },
    ]);
    expect(result.integrity).toMatchObject({
      before: { status: 'violations', violationCount: 1 },
      after: { status: 'consistent', violationCount: 0 },
      introduced: [],
      resolved: [{ bindings: { P: 'mira' } }],
    });
  });

  it('distinguishes accepted-view addition from tentative-view provenance transition', () => {
    const store = diffStore('trust');
    assertTentativeFacts(store, 'default', 'status(mira, active).', {
      opId: 'tentative',
    });
    resolveTentativeFacts(
      store,
      'default',
      'status(mira, active).',
      'accept',
      { opId: 'accepted' }
    );

    const accepted = diffRecordedKnowledge(store, 1, 2, {
      query: 'status(mira, State)',
    });
    expect(accepted.clauses.added).toMatchObject([
      { clause: 'status(mira, active).', sources: [{ opId: 'accepted' }] },
    ]);
    expect(accepted.queryImpact?.added).toMatchObject([
      { bindings: { State: 'active' } },
    ]);

    const included = diffRecordedKnowledge(store, 1, 2, {
      trustMode: 'include_tentative',
      query: 'status(mira, State)',
    });
    expect(included).toMatchObject({
      trustMode: 'include_tentative',
      clauses: {
        added: [],
        removed: [],
        sourceChanged: [
          {
            beforeClause: 'status(mira, active).',
            afterClause: 'status(mira, active).',
            beforeSources: [{ opId: 'tentative', trust: 'tentative' }],
            afterSources: [{ opId: 'accepted', trustAction: 'accept' }],
          },
        ],
      },
      queryImpact: {
        added: [],
        removed: [],
        evidenceChanged: [
          {
            before: { proofs: [{ trust: 'tentative' }] },
            after: { proofs: [{ sources: [{ trustAction: 'accept' }] }] },
          },
        ],
      },
    });
  });

  it('applies canonical identity before comparing historical clauses and query rows', () => {
    const store = diffStore('identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity' }
    );
    store.assert('default', 'works_at(mira, initech).', { opId: 'later' });

    const result = diffRecordedKnowledge(store, 1, 2, {
      entityIdentity: 'canonical',
      query: 'works_at(mira, Company)',
    });
    expect(result.clauses.added).toMatchObject([
      { clause: 'works_at(mira, initech).' },
    ]);
    expect(result.queryImpact?.before.rows).toMatchObject([
      {
        bindings: { Company: 'acme' },
        proofs: [{ projectedFrom: "works_at('Mira Patel', acme)." }],
      },
    ]);
    expect(result.queryImpact?.added).toMatchObject([
      { bindings: { Company: 'initech' } },
    ]);
  });

  it('reports identity-policy declarations even though reasoning views hide metadata', () => {
    const store = diffStore('identity-metadata');
    store.assert('default', "works_at('Mira Patel', acme).", { opId: 'fact' });
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).`,
      { opId: 'identity-policy' }
    );

    const literal = diffRecordedKnowledge(store, 1, 2);
    expect(literal.clauses.added).toMatchObject([
      {
        kind: 'identity_metadata',
        clause: "rembero_alias('Mira Patel', mira).",
        sources: [{ opId: 'identity-policy' }],
      },
      {
        kind: 'identity_metadata',
        clause: 'rembero_entity_position(works_at, 2, 0).',
      },
    ]);

    const canonical = diffRecordedKnowledge(store, 1, 2, {
      entityIdentity: 'canonical',
    });
    expect(canonical.clauses.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fact', clause: 'works_at(mira, acme).' }),
        expect.objectContaining({ kind: 'identity_metadata' }),
      ])
    );
    expect(canonical.clauses.removed).toMatchObject([
      { kind: 'fact', clause: "works_at('Mira Patel', acme)." },
    ]);
  });

  it('shows audit-only sequence movement without inventing knowledge change', () => {
    const store = diffStore('audit');
    store.note('default', 'auto_capture', {
      captureId: 'audit-only',
      status: 'empty',
    });

    const result = diffRecordedKnowledge(store, 0, 1);
    expect(result).toMatchObject({
      changed: false,
      journalEntriesTraversed: 1,
      clauses: { added: [], removed: [], sourceChanged: [] },
      topology: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
      },
      integrity: { introduced: [], resolved: [] },
    });
  });

  it('validates sequence order, batches coherent snapshots, and caps output changes', () => {
    const store = diffStore('limits');
    store.assert('default', 'item(a).', { opId: 'item' });
    expect(() => diffRecordedKnowledge(store, 1, 0)).toThrow(/must not exceed/i);
    expect(() => diffRecordedKnowledge(store, 0, 2)).toThrow(/exceeds journal length/i);
    const snapshots = store.recordedSnapshots(['default'], []);
    expect(snapshots).toEqual([]);
    expect(() =>
      store.recordedSnapshots(
        ['default'],
        Array.from({ length: MAX_RECORDED_SNAPSHOT_BATCH + 1 }, () => 0)
      )
    ).toThrow(/batch exceeds 64/i);

    const large = diffStore('change-limit');
    large.assert(
      'default',
      Array.from(
        { length: MAX_RECORDED_DIFF_CHANGES + 1 },
        (_, index) => `item(${index}).`
      ).join('\n'),
      { opId: 'large' }
    );
    expect(() => diffRecordedKnowledge(large, 0, 1)).toThrow(
      /exceeded 10000 clause changes/i
    );
  });
});
