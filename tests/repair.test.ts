import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planKnowledgeRepair } from '../src/knowledge/repair.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function repairStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-repair-${label}-`)));
}

describe('verified deterministic repair planning', () => {
  it('proposes and verifies one missing ground premise without writing it', () => {
    const store = repairStore('missing');
    store.assert(
      'default',
      'employee(bob). eligible(X) :- employee(X), badge(X).',
      { opId: 'baseline' }
    );
    const before = store.clausesFor(['default']);

    const result = planKnowledgeRepair(store, 'eligible(bob)');

    expect(result).toMatchObject({
      status: 'repairable',
      namespace: 'default',
      namespaces: ['default'],
      baseline: { status: 'blocked' },
      plans: [
        {
          assume: ['badge(bob).'],
          without: [],
          changeCount: 1,
          searchDepth: 1,
          strictIntegritySafe: true,
          noNewViolationsSafe: true,
          application: { assumed: ['badge(bob).'] },
          candidate: {
            rows: [
              {
                bindings: {},
                proofs: [
                  {
                    rule: 1,
                    because: [
                      expect.objectContaining({ predicate: 'employee' }),
                      expect.objectContaining({
                        predicate: 'badge',
                        sources: expect.arrayContaining([
                          expect.objectContaining({ hypothetical: true }),
                        ]),
                      }),
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(result.baselineDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(store.clausesFor(['default'])).toEqual(before);
    expect(store.recordedSnapshot(['default'], 1).journalEntries).toBe(1);
  });

  it('iterates through sequential missing premises and returns a subset-minimal plan', () => {
    const store = repairStore('sequential');
    store.assert(
      'default',
      `employee(bob).
       ready(X) :- employee(X), badge(X), trained(X).`,
      { opId: 'baseline' }
    );

    const result = planKnowledgeRepair(store, 'ready(bob)');
    expect(result).toMatchObject({
      status: 'repairable',
      plans: [
        {
          assume: ['badge(bob).', 'trained(bob).'],
          without: [],
          changeCount: 2,
          searchDepth: 2,
          candidate: { rows: [{ bindings: {} }] },
        },
      ],
    });
    expect(result.searchedStates).toBeGreaterThanOrEqual(3);
  });

  it('returns every minimal alternative rule plan in stable order', () => {
    const store = repairStore('alternatives');
    store.assert(
      'default',
      'answer(a) :- left(a). answer(a) :- right(a).',
      { opId: 'rules' }
    );

    const result = planKnowledgeRepair(store, 'answer(a)');
    expect(result.status).toBe('repairable');
    expect(result.plans).toHaveLength(2);
    expect(result.plans.map(({ assume }) => assume)).toEqual(
      expect.arrayContaining([['left(a).'], ['right(a).']])
    );
    expect(result.plans.every(({ changeCount }) => changeCount === 1)).toBe(true);
  });

  it('minimizes actual fact-change count rather than diagnostic step count', () => {
    const store = repairStore('cost');
    store.assert(
      'default',
      `block_one(a). block_two(a). block_three(a).
       answer(a) :- \\+ block_one(a), \\+ block_two(a), \\+ block_three(a).
       answer(a) :- first(a), second(a).`,
      { opId: 'alternatives' }
    );

    const result = planKnowledgeRepair(store, 'answer(a)');
    expect(result.plans).toMatchObject([
      {
        assume: ['first(a).', 'second(a).'],
        without: [],
        changeCount: 2,
      },
    ]);
  });

  it('retracts every stored fact that blocks a grounded negation', () => {
    const store = repairStore('negation');
    store.assert(
      'default',
      'employee(bob). suspended(bob). eligible(X) :- employee(X), \\+ suspended(X).',
      { opId: 'baseline' }
    );

    const result = planKnowledgeRepair(store, 'eligible(bob)');
    expect(result.plans).toMatchObject([
      {
        assume: [],
        without: ['suspended(bob)'],
        application: { retracted: ['suspended(bob).'] },
        candidate: { rows: [{ bindings: {} }] },
      },
    ]);
    expect(store.clausesFor(['default']).map((clause) => clause.head.predicate)).toEqual([
      'employee',
      'suspended',
      'eligible',
    ]);
  });

  it('keeps a proven query repair visible while marking introduced policy violations', () => {
    const store = repairStore('integrity');
    store.assert(
      'default',
      `employee(bob).
       eligible(X) :- employee(X), badge(X).
       :- badge(bob).`,
      { opId: 'baseline' }
    );

    const result = planKnowledgeRepair(store, 'eligible(bob)');
    expect(result.plans).toMatchObject([
      {
        assume: ['badge(bob).'],
        strictIntegritySafe: false,
        noNewViolationsSafe: false,
        integrityDelta: {
          introduced: [{ bindings: {} }],
          candidate: { status: 'violations', violationCount: 1 },
        },
      },
    ]);
  });

  it('retracts the literal source fact behind a canonical identity blocker', () => {
    const store = repairStore('identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(person, 1, 0).
       rembero_entity_position(suspended, 1, 0).
       person('Mira Patel').
       suspended('Mira Patel').
       eligible(X) :- person(X), \\+ suspended(X).`,
      { opId: 'identity-baseline' }
    );

    const result = planKnowledgeRepair(store, 'eligible(mira)', {
      entityIdentity: 'canonical',
    });
    expect(result.plans).toMatchObject([
      {
        assume: [],
        without: ["suspended('Mira Patel')"],
        candidate: { rows: [{ bindings: {} }] },
      },
    ]);
  });

  it('respects tentative trust and target-namespace retraction authority', () => {
    const trustStore = repairStore('trust');
    trustStore.assert(
      'default',
      'employee(bob). eligible(X) :- employee(X), badge(X).',
      { opId: 'accepted' }
    );
    assertTentativeFacts(trustStore, 'default', 'badge(bob).', {
      opId: 'tentative',
    });
    expect(planKnowledgeRepair(trustStore, 'eligible(bob)')).toMatchObject({
      status: 'repairable',
      plans: [{ assume: ['badge(bob).'] }],
    });
    expect(
      planKnowledgeRepair(trustStore, 'eligible(bob)', {
        trustMode: 'include_tentative',
      })
    ).toMatchObject({ status: 'already_satisfied', plans: [] });

    const namespaceStore = repairStore('namespace');
    namespaceStore.assert(
      'default',
      'employee(bob). eligible(X) :- employee(X), \\+ suspended(X).',
      { opId: 'rule' }
    );
    namespaceStore.assert('shared', 'suspended(bob).', { opId: 'shared' });
    expect(
      planKnowledgeRepair(namespaceStore, 'eligible(bob)', {
        namespace: 'default',
        namespaces: ['default', 'shared'],
      })
    ).toMatchObject({ status: 'unresolved', plans: [] });
  });

  it('distinguishes an already satisfied query from an unresolved ungrounded repair', () => {
    const satisfiedStore = repairStore('satisfied');
    satisfiedStore.assert('default', 'item(a).', { opId: 'item' });
    expect(planKnowledgeRepair(satisfiedStore, 'item(a)')).toMatchObject({
      status: 'already_satisfied',
      plans: [],
      searchedStates: 1,
    });

    const unresolvedStore = repairStore('unresolved');
    unresolvedStore.assert(
      'default',
      'eligible(X) :- employee(X), badge(X).',
      { opId: 'rule' }
    );
    expect(planKnowledgeRepair(unresolvedStore, 'eligible(Person)')).toMatchObject({
      status: 'unresolved',
      plans: [],
      baseline: { failures: [{ reason: 'rules_blocked' }] },
    });
  });

  it('fails closed when depth, state, or plan bounds cannot cover the search', () => {
    const sequential = repairStore('depth');
    sequential.assert(
      'default',
      'ready(a) :- one(a), two(a).',
      { opId: 'rule' }
    );
    expect(() =>
      planKnowledgeRepair(sequential, 'ready(a)', { maxSteps: 1 })
    ).toThrow(/exceeded depth 1/i);

    const branching = repairStore('plans');
    branching.assert(
      'default',
      'answer(a) :- left(a). answer(a) :- right(a).',
      { opId: 'rules' }
    );
    expect(() =>
      planKnowledgeRepair(branching, 'answer(a)', { maxPlans: 1 })
    ).toThrow(/exceeded 1 plans/i);
    expect(() =>
      planKnowledgeRepair(branching, 'answer(a)', { maxSearchStates: 1 })
    ).toThrow(/exceeded 1 states/i);
  });
});
