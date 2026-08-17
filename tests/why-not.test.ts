import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { explainWhyNot, type WhyNotFailure } from '../src/knowledge/why-not.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function flattenFailures(failures: WhyNotFailure[]): WhyNotFailure[] {
  return failures.flatMap((failure) => [
    failure,
    ...failure.rules.flatMap((rule) => flattenFailures(rule.failures)),
  ]);
}

function sourceStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-why-not-${label}-`)));
}

describe('deterministic why-not explanations', () => {
  it('reports a missing fact with the closest sourced evidence and blocker graph', () => {
    const store = sourceStore('missing');
    store.assert('default', 'works_at(mira, initech).', {
      opId: 'employment-source',
      sourceText: 'Mira works at Initech.',
    });

    const result = explainWhyNot(
      store.clausesFor(['default']),
      'works_at(mira, acme)',
      store.sourcesFor(['default'])
    );

    expect(result).toMatchObject({
      status: 'blocked',
      evaluatedQuery: 'works_at(mira, acme)',
      failures: [
        {
          reason: 'missing_fact',
          goal: 'works_at(mira, acme)',
          nearby: [
            {
              fact: 'works_at(mira, initech).',
              explanation: {
                rows: [{ proofs: [{ sources: [{ opId: 'employment-source' }] }] }],
              },
            },
          ],
        },
      ],
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'query', status: 'blocked' }),
        expect.objectContaining({ kind: 'failure', reason: 'missing_fact' }),
        expect.objectContaining({ kind: 'observed', fact: 'works_at(mira, initech).' }),
      ])
    );
    expect(result.graph.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(['fails_at', 'observed'])
    );
  });

  it('walks recursive rule alternatives to their missing base premises', () => {
    const program = parseProgram(`
      parent(alice, bob).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `);

    const result = explainWhyNot(program, 'ancestor(alice, carol)');
    const failures = flattenFailures(result.failures);

    expect(result.status).toBe('blocked');
    expect(result.failures[0]).toMatchObject({
      reason: 'rules_blocked',
      goal: 'ancestor(alice, carol)',
      rules: [{ rule: 1 }, { rule: 2 }],
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'missing_fact', goal: 'parent(alice, carol)' }),
        expect.objectContaining({ reason: 'missing_fact', goal: 'parent(bob, carol)' }),
        expect.objectContaining({ reason: 'missing_fact', goal: 'parent(bob, Z)' }),
      ])
    );
    expect(result.graph.nodes.some((node) => node.kind === 'rule' && node.rule === 2)).toBe(
      true
    );
  });

  it('terminates cyclic diagnostic branches with an explicit recursion blocker', () => {
    const result = explainWhyNot(
      parseProgram('loop(X) :- loop(X).'),
      'loop(a)'
    );
    expect(flattenFailures(result.failures)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'recursive_cycle',
          goal: 'loop(a)',
        }),
      ])
    );
  });

  it('shows the present fact that blocks a negated rule premise', () => {
    const store = sourceStore('negation');
    store.assert(
      'default',
      'employee(bob). suspended(bob). eligible(X) :- employee(X), \\+ suspended(X).',
      { opId: 'work-state' }
    );

    const result = explainWhyNot(
      store.clausesFor(['default']),
      'eligible(bob)',
      store.sourcesFor(['default'])
    );
    const blocker = flattenFailures(result.failures).find(
      (failure) => failure.reason === 'negated_fact_present'
    );

    expect(blocker).toMatchObject({
      goal: '\\+ suspended(bob)',
      bindings: { X: 'bob' },
      nearby: [
        {
          fact: 'suspended(bob).',
          explanation: { rows: [{ proofs: [{ sources: [{ opId: 'work-state' }] }] }] },
        },
      ],
    });
  });

  it('grounds and reports a false arithmetic comparison', () => {
    const result = explainWhyNot(
      parseProgram('age(tim, 15). adult(X) :- age(X, A), A >= 18.'),
      'adult(tim)'
    );
    expect(flattenFailures(result.failures)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'comparison_false',
          goal: '15 >= 18',
          bindings: { X: 'tim', A: '15' },
        }),
      ])
    );
  });

  it('retains every eliminated conjunction branch rather than reporting one witness', () => {
    const result = explainWhyNot(
      parseProgram('parent(alice, bob). parent(alice, carol). likes(bob, pizza).'),
      'parent(alice, Child), likes(Child, sushi)'
    );

    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((failure) => failure.bindings.Child)).toEqual([
      'bob',
      'carol',
    ]);
    expect(result.failures.every((failure) => failure.goal.endsWith(', sushi)'))).toBe(
      true
    );
  });

  it('distinguishes aggregate output mismatch from missing contributors', () => {
    const result = explainWhyNot(
      parseProgram(`
        member(red, alice).
        team_size(Team, Count) :- count(*) as Count where member(Team, Person).
      `),
      'team_size(red, 2)'
    );
    expect(result.failures[0]).toMatchObject({
      reason: 'rules_blocked',
      nearby: [{ fact: 'team_size(red, 1).' }],
      rules: [
        {
          aggregate: true,
          failures: [{ reason: 'aggregate_result_mismatch' }],
        },
      ],
    });
    const emptyCount = explainWhyNot(
      parseProgram('item_count(Count) :- count(*) as Count where item(Value).'),
      'item_count(1)'
    );
    expect(emptyCount.failures[0]?.rules[0]?.failures[0]).toMatchObject({
      reason: 'aggregate_result_mismatch',
      goal: 'item_count(1)',
    });
  });

  it('uses the same canonical identity and tentative trust views as query explanation', () => {
    const store = sourceStore('projection');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', initech).`,
      { opId: 'identity-source' }
    );
    assertTentativeFacts(store, 'default', 'status(mira, paused).', {
      opId: 'tentative-source',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    const canonical = explainWhyNot(clauses, 'works_at(mira, acme)', sources, {
      entityIdentity: 'canonical',
    });
    expect(canonical.failures[0]?.nearby[0]).toMatchObject({
      fact: 'works_at(mira, initech).',
      explanation: {
        rows: [
          {
            proofs: [
              {
                projectedFrom: "works_at('Mira Patel', initech).",
                sources: [{ opId: 'identity-source' }],
              },
            ],
          },
        ],
      },
    });

    expect(explainWhyNot(clauses, 'status(mira, paused)', sources).status).toBe(
      'blocked'
    );
    const tentative = explainWhyNot(clauses, 'status(mira, paused)', sources, {
      trustMode: 'include_tentative',
    });
    expect(tentative.status).toBe('satisfied');
    expect(tentative.explanation.rows[0]?.proofs[0]).toMatchObject({
      trust: 'tentative',
    });
  });

  it('returns the ordinary sourced explanation when the query is already satisfied', () => {
    const store = sourceStore('satisfied');
    store.assert('default', 'pet(rahul, luna).', { opId: 'pet-source' });
    const result = explainWhyNot(
      store.clausesFor(['default']),
      'pet(rahul, Name)',
      store.sourcesFor(['default'])
    );

    expect(result).toMatchObject({
      status: 'satisfied',
      failures: [],
      explanation: {
        rows: [
          {
            bindings: { Name: 'luna' },
            proofs: [{ sources: [{ opId: 'pet-source' }] }],
          },
        ],
      },
    });
    expect(result.graph.nodes).toHaveLength(1);
  });

  it('fails closed when diagnostic limits cannot cover every branch', () => {
    expect(() =>
      explainWhyNot(
        parseProgram('item(a). item(b). item(c).'),
        'item(X), missing(X)',
        new Map(),
        { maxFailures: 2 }
      )
    ).toThrow(/exceeded 2 (?:bindings|failures)/i);
    expect(() =>
      explainWhyNot([], 'missing(X)', new Map(), { maxDiagnosticDepth: 0 })
    ).toThrow(/maxDiagnosticDepth must be from 1/i);
  });
});
