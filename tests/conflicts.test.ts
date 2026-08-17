import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineSafetyError, parseProgram } from '../src/engine/index.js';
import {
  inspectConflicts,
  MAX_CONFLICT_FOCUS_BYTES,
} from '../src/knowledge/conflicts.js';
import { MemoryStore } from '../src/store/store.js';

function conflictStore(): MemoryStore {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-conflicts-')));
  store.assert('personal', 'status(mira, active).', { opId: 'mira-active' });
  store.assert('personal', 'status(mira, terminated).', { opId: 'mira-terminated' });
  store.assert('personal', 'status(zoe, active). status(zoe, terminated).', {
    opId: 'zoe-statuses',
  });
  store.assert('personal', 'works_at(mira, acme).', { opId: 'mira-acme' });
  store.assert('personal', 'works_at(mira, initech).', { opId: 'mira-initech' });
  store.assert(
    'policy',
    `:- status(Person, active), status(Person, terminated).
     :- works_at(Person, Left), works_at(Person, Right), Left < Right.`,
    { opId: 'personal-policies' }
  );
  return store;
}

describe('deterministic conflict views', () => {
  it('groups complete policy evidence by the first alpha-stable binding', () => {
    const store = conflictStore();
    const clauses = store.clausesFor(['policy', 'personal']);
    const sources = store.sourcesFor(['policy', 'personal']);
    const run = () => inspectConflicts(clauses, sources);
    const result = run();

    expect(run()).toEqual(result);
    expect(result).toMatchObject({
      status: 'violations',
      constraintCount: 2,
      violationCount: 3,
      matchingViolationCount: 3,
      clusterCount: 2,
    });
    expect(result.clusters.map((cluster) => cluster.focus)).toEqual(['mira', 'zoe']);
    const mira = result.clusters[0];
    expect(mira).toMatchObject({
      violationCount: 2,
      constraintIds: [
        expect.stringMatching(/^constraint:/),
        expect.stringMatching(/^constraint:/),
      ],
      constraints: [
        { sources: [{ namespace: 'policy', opId: 'personal-policies' }] },
        { sources: [{ namespace: 'policy', opId: 'personal-policies' }] },
      ],
      rows: [
        {
          focusBinding: 'Person',
          bindings: { Person: 'mira' },
          proofs: [
            { sources: [{ opId: 'mira-active' }] },
            { sources: [{ opId: 'mira-terminated' }] },
          ],
        },
        {
          focusBinding: 'Person',
          bindings: { Left: 'acme', Person: 'mira', Right: 'initech' },
        },
      ],
    });
    expect(mira.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: mira.id,
          kind: 'conflict',
          focus: 'mira',
          violationCount: 2,
        }),
        expect.objectContaining({ kind: 'claim', predicate: 'status' }),
        expect.objectContaining({ kind: 'claim', predicate: 'works_at' }),
      ])
    );
    expect(
      mira.graph.edges.filter(
        (edge) => edge.kind === 'contains' && edge.from === mira.id
      )
    ).toHaveLength(2);
  });

  it('filters one focus and selects its complete conflict support graph', () => {
    const store = conflictStore();
    const clauses = store.clausesFor(['policy', 'personal']);
    const sources = store.sourcesFor(['policy', 'personal']);
    const focused = inspectConflicts(clauses, sources, { focus: 'mira' });
    expect(focused).toMatchObject({
      status: 'violations',
      violationCount: 3,
      focus: 'mira',
      matchingViolationCount: 2,
      clusterCount: 1,
      clusters: [{ focus: 'mira', violationCount: 2 }],
    });

    const clusterId = focused.clusters[0].id;
    const selected = inspectConflicts(clauses, sources, {
      focus: 'mira',
      graphSelector: { kind: 'support', nodeId: clusterId },
    });
    expect(selected.clusters[0].graphSelection).toMatchObject({
      selector: { kind: 'support', nodeId: clusterId },
      focusNodeIds: [clusterId],
    });
    expect(selected.clusters[0].graph.nodes).toEqual(focused.clusters[0].graph.nodes);
    expect(selected.clusters[0].graph.edges).toEqual(focused.clusters[0].graph.edges);

    expect(inspectConflicts(clauses, sources, { focus: 'nobody' })).toMatchObject({
      status: 'violations',
      violationCount: 3,
      focus: 'nobody',
      matchingViolationCount: 0,
      clusterCount: 0,
      clusters: [],
    });
  });

  it('keeps row graph selection distinct when policies produce identical bindings', () => {
    const program = parseProgram(`
      active(mira).
      suspended(mira).
      banned(mira).
      :- active(Person), suspended(Person).
      :- active(Person), banned(Person).
    `);
    const result = inspectConflicts(program, new Map(), { focus: 'mira' });
    const cluster = result.clusters[0];

    expect(cluster.rows).toHaveLength(2);
    expect(new Set(cluster.rows.map((row) => row.graphResultId)).size).toBe(2);
    expect(cluster.graph.nodes.filter((node) => node.kind === 'result')).toHaveLength(2);

    for (const [index, row] of cluster.rows.entries()) {
      const selected = inspectConflicts(program, new Map(), {
        focus: 'mira',
        graphSelector: { kind: 'result', row: index + 1 },
      }).clusters[0];
      const claimPredicates = selected.graph.nodes
        .filter((node) => node.kind === 'claim')
        .map((node) => node.predicate);
      const expected = row.constraintClause.includes('banned')
        ? 'banned'
        : 'suspended';
      const excluded = expected === 'banned' ? 'suspended' : 'banned';

      expect(selected.graphSelection?.focusNodeIds).toEqual([row.graphResultId]);
      expect(claimPredicates).toContain('active');
      expect(claimPredicates).toContain(expected);
      expect(claimPredicates).not.toContain(excluded);
    }
  });

  it('collapses alias-split violations and resolves an alias focus only when canonical identity is requested', () => {
    const program = parseProgram(`
      rembero_alias('Mira Patel', mira).
      rembero_entity_position(status, 2, 0).
      status('Mira Patel', active).
      status(mira, terminated).
      :- status(Person, active), status(Person, terminated).
    `);

    expect(inspectConflicts(program).status).toBe('consistent');
    const canonical = inspectConflicts(program, new Map(), {
      entityIdentity: 'canonical',
      focus: "'Mira Patel'",
    });
    expect(canonical).toMatchObject({
      status: 'violations',
      focus: 'mira',
      matchingViolationCount: 1,
      clusters: [{ focus: 'mira', rows: [{ focusBinding: 'Person' }] }],
    });
  });

  it('keeps variable-free policy in one explicit global cluster', () => {
    const result = inspectConflicts(parseProgram('outage. :- outage.'));
    expect(result).toMatchObject({
      status: 'violations',
      violationCount: 1,
      clusterCount: 1,
      clusters: [
        {
          focus: null,
          rows: [{ bindings: {}, constraintRow: 1 }],
        },
      ],
    });
  });

  it('rejects ambiguous, non-ground, or oversized focus input before evaluation', () => {
    const program = parseProgram('status(mira, active).');
    for (const focus of ['X', '_', 'mira, zoe', 'mira). injected(value']) {
      expect(() => inspectConflicts(program, new Map(), { focus })).toThrow(
        EngineSafetyError
      );
    }
    expect(() =>
      inspectConflicts(program, new Map(), {
        focus: 'x'.repeat(MAX_CONFLICT_FOCUS_BYTES + 1),
      })
    ).toThrow(/exceeds/i);
  });

  it('fails closed before returning a partial cluster set', () => {
    expect(() =>
      inspectConflicts(
        parseProgram('item(a). item(b). :- item(Person).'),
        new Map(),
        { maxViolations: 1 }
      )
    ).toThrow(/exceeded maxViolations 1/i);
  });
});
