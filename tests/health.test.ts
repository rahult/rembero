import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectKnowledgeHealth } from '../src/knowledge/health.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function healthStore(label: string): { root: string; store: MemoryStore } {
  const root = mkdtempSync(join(tmpdir(), `rembero-health-${label}-`));
  return { root, store: new MemoryStore(root) };
}

describe('deterministic personal knowledge health', () => {
  it('reports one sourced consistent rule program as healthy', () => {
    const { store } = healthStore('healthy');
    store.assert(
      'default',
      'base(a). derived(X) :- base(X).',
      { opId: 'healthy-source' }
    );

    const result = inspectKnowledgeHealth(store);

    expect(result).toMatchObject({
      status: 'healthy',
      stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      namespaces: ['default'],
      clauseCount: 2,
      sourceWitnessCount: 2,
      findings: [],
      integrity: { status: 'unconstrained', violationCount: 0 },
      rules: { status: 'clean', warningCount: 0, topology: { ruleCount: 1 } },
      trust: { pendingTentativeCount: 0, pendingClauses: [] },
      identity: { aliasCount: 0, positionCount: 0 },
      provenance: {
        sourcedClauseCount: 2,
        unsourcedClauseCount: 0,
        sourceCoveragePercent: 100,
        unsourced: [],
      },
    });
    expect(inspectKnowledgeHealth(store).stateDigest).toBe(result.stateDigest);
  });

  it('composes integrity, rule, tentative, check, and coverage findings', () => {
    const { store } = healthStore('review');
    store.assert(
      'default',
      `employee(alice). suspended(alice).
       eligible(X) :- employee(X), \\+ blocked(X).
       :- employee(X), suspended(X).`,
      { opId: 'problem-source' }
    );
    assertTentativeFacts(store, 'default', 'favorite_color(alice, blue).', {
      opId: 'tentative-source',
    });

    const result = inspectKnowledgeHealth(store, {
      checkSuite: {
        version: 1,
        coverage: { minimumPercent: 100 },
        checks: [
          {
            name: 'Alice should not be suspended',
            query: 'suspended(alice)',
            expect: { kind: 'empty' },
          },
        ],
      },
    });

    expect(result.status).toBe('violations');
    expect(result.findings.map(({ code }) => code)).toEqual([
      'integrity_violations',
      'coverage_failed',
      'knowledge_checks_failed',
      'rule_warnings',
      'tentative_claims_pending',
    ]);
    expect(result).toMatchObject({
      integrity: { status: 'violations', violationCount: 1 },
      rules: { status: 'review', warningCount: 1 },
      checks: {
        status: 'failed',
        failedCount: 1,
        coverage: { percent: 0, passed: false },
      },
      trust: {
        pendingTentativeCount: 1,
        pendingClauses: ['favorite_color(alice, blue).'],
      },
    });
  });

  it('counts canonical identity metadata and validates the declared view', () => {
    const { store } = healthStore('identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity-source' }
    );

    const result = inspectKnowledgeHealth(store, {
      entityIdentity: 'canonical',
    });

    expect(result).toMatchObject({
      status: 'healthy',
      identity: {
        aliasCount: 1,
        positionCount: 1,
        aliases: [
          expect.objectContaining({ alias: 'Mira Patel', canonical: 'mira' }),
        ],
        positions: [
          expect.objectContaining({ predicate: 'works_at', position: 0 }),
        ],
      },
    });
  });

  it('detects current direct-edit provenance gaps without guessing a source', () => {
    const { root } = healthStore('unsourced');
    writeFileSync(
      join(root, 'default.dl'),
      '% manually edited\nmanual_fact(value).\n',
      'utf8'
    );
    const store = new MemoryStore(root);

    const result = inspectKnowledgeHealth(store, { namespaces: ['default'] });

    expect(result).toMatchObject({
      status: 'review',
      findings: [
        expect.objectContaining({ code: 'missing_provenance', count: 1 }),
      ],
      provenance: {
        sourcedClauseCount: 0,
        unsourcedClauseCount: 1,
        sourceCoveragePercent: 0,
        unsourced: [{ namespace: 'default', clause: 'manual_fact(value).' }],
      },
    });
  });

  it('keeps exact recorded health isolated from later violations', () => {
    const { store } = healthStore('recorded');
    store.assert(
      'default',
      'employee(alice). :- employee(X), suspended(X).',
      { opId: 'baseline' }
    );
    store.assert('default', 'suspended(alice).', { opId: 'later' });

    const past = inspectKnowledgeHealth(store, {
      namespaces: ['default'],
      recordedSequence: 1,
    });
    const current = inspectKnowledgeHealth(store, { namespaces: ['default'] });

    expect(past).toMatchObject({
      status: 'review',
      recordedSnapshot: { sequence: 1, journalEntries: 2 },
      integrity: { status: 'consistent', violationCount: 0 },
      findings: [expect.objectContaining({ code: 'rule_warnings' })],
    });
    expect(current).toMatchObject({
      status: 'violations',
      integrity: { status: 'violations', violationCount: 1 },
    });
    expect(past.stateDigest).not.toBe(current.stateDigest);
  });
});
