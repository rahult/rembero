import { describe, it, expect } from 'vitest';
import {
  evaluate,
  evaluateQuerySpec,
  evaluateQuerySpecWithProof,
  evaluateWithProof,
  parseProgram,
  parseQuery,
  parseQuerySpec,
  serializeTerm,
  EngineLimitError,
  EngineSafetyError,
  type EvaluateOptions,
  type Bindings,
  type Clause,
  type Goal,
  type ScalarExpression,
  materializeWithProof,
  literalMatches,
} from '../src/engine/index.js';

/** Render bindings as sorted "X=a Y=b" rows for order-independent assertions. */
function rows(bindings: Bindings[]): string[] {
  return bindings
    .map((b) =>
      Object.entries(b)
        .map(([name, term]) => `${name}=${serializeTerm(term)}`)
        .sort()
        .join(' ')
    )
    .sort();
}

function run(program: string, query: string, options?: EvaluateOptions) {
  return evaluate(parseProgram(program), parseQuery(query), options);
}

function explain(
  program: string,
  query: string,
  options?: EvaluateOptions
) {
  return evaluateWithProof(parseProgram(program), parseQuery(query), options);
}

function runSpec(program: string, query: string, options?: EvaluateOptions) {
  return evaluateQuerySpec(parseProgram(program), parseQuerySpec(query), options);
}

function explainSpec(program: string, query: string, options?: EvaluateOptions) {
  return evaluateQuerySpecWithProof(parseProgram(program), parseQuerySpec(query), options);
}

describe('evaluate: facts and joins', () => {
  const db = `
    works_at(rahul, acme).
    works_at(maya, acme).
    works_at(chen, initech).
    lives_in(rahul, sydney).
    lives_in(maya, melbourne).
  `;

  it('answers a ground query with one empty binding when true', () => {
    expect(run(db, 'works_at(rahul, acme)')).toEqual([{}]);
  });

  it('answers a false ground query with no bindings', () => {
    expect(run(db, 'works_at(rahul, initech)')).toEqual([]);
  });

  it('binds variables against facts', () => {
    expect(rows(run(db, 'works_at(X, acme)'))).toEqual(['X=maya', 'X=rahul']);
  });

  it('joins conjunctive goals on shared variables', () => {
    expect(rows(run(db, 'works_at(X, acme), lives_in(X, sydney)'))).toEqual(['X=rahul']);
  });

  it('supports wildcards without binding them', () => {
    expect(run(db, 'works_at(rahul, _)')).toEqual([{}]);
    expect(rows(run(db, 'works_at(X, _)'))).toEqual(['X=chen', 'X=maya', 'X=rahul']);
  });

  it('handles zero-arity predicates', () => {
    expect(run('raining.', 'raining')).toEqual([{}]);
    expect(run('raining.', 'sunny')).toEqual([]);
  });
});

describe('evaluate: rules', () => {
  it('derives via a non-recursive rule with a comparison', () => {
    const db = `
      works_at(rahul, acme).
      works_at(maya, acme).
      works_at(chen, initech).
      colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
    `;
    expect(rows(run(db, 'colleague(rahul, Who)'))).toEqual(['Who=maya']);
  });

  it('computes transitive closure (ancestor)', () => {
    const db = `
      parent(alice, bob).
      parent(bob, carol).
      parent(carol, dan).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `;
    expect(rows(run(db, 'ancestor(alice, X)'))).toEqual(['X=bob', 'X=carol', 'X=dan']);
    expect(rows(run(db, 'ancestor(X, dan)'))).toEqual(['X=alice', 'X=bob', 'X=carol']);
  });

  it('computes same-generation', () => {
    const db = `
      person(alice). person(bob). person(betty). person(carol). person(chad).
      parent(alice, bob).
      parent(alice, betty).
      parent(bob, carol).
      parent(betty, chad).
      sg(X, X) :- person(X).
      sg(X, Y) :- parent(PX, X), parent(PY, Y), sg(PX, PY).
    `;
    expect(rows(run(db, 'sg(carol, Y), carol != Y'))).toEqual(['Y=chad']);
  });

  it('deduplicates derived facts across multiple derivation paths', () => {
    const db = `
      edge(a, b). edge(b, d). edge(a, c). edge(c, d).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;
    expect(rows(run(db, 'path(a, X)'))).toEqual(['X=b', 'X=c', 'X=d']);
  });
});

describe('evaluate: comparison builtins', () => {
  const db = `
    age(rahul, 38).
    age(maya, 29).
    age(kid, 11).
  `;

  it('filters with numeric comparisons', () => {
    expect(rows(run(db, 'age(X, A), A >= 29'))).toEqual(['A=29 X=maya', 'A=38 X=rahul']);
    expect(rows(run(db, 'age(X, A), A < 18'))).toEqual(['A=11 X=kid']);
  });

  it('compares atoms lexicographically', () => {
    expect(rows(run('name(a). name(b).', 'name(X), X > a'))).toEqual(['X=b']);
  });

  it('fails mixed-type ordered comparisons instead of throwing', () => {
    expect(run(db, 'age(rahul, A), A > banana')).toEqual([]);
  });

  it('supports equality on ground terms', () => {
    expect(rows(run(db, 'age(X, A), A = 38'))).toEqual(['A=38 X=rahul']);
  });

  it('evaluates arithmetic with standard precedence and grouping', () => {
    expect(rows(run(db, 'age(X, A), A > 10 + 3 * 6'))).toEqual([
      'A=29 X=maya',
      'A=38 X=rahul',
    ]);
    expect(rows(run(db, 'age(X, A), A > (10 + 3) * 2'))).toEqual([
      'A=29 X=maya',
      'A=38 X=rahul',
    ]);
    expect(rows(run(db, 'age(X, A), A > (10 + 5) * 2'))).toEqual([
      'A=38 X=rahul',
    ]);
  });

  it('evaluates subtraction and division left-associatively on either side', () => {
    const values = 'value(five, 5). value(two, 2). value(negative, -5).';
    expect(rows(run(values, 'value(X, V), V = 10 - 3 - 2'))).toEqual([
      'V=5 X=five',
    ]);
    expect(rows(run(values, 'value(X, V), 20 / 2 / 2 = V'))).toEqual([
      'V=5 X=five',
    ]);
    expect(rows(run(values, 'value(X, V), -V = 5'))).toEqual([
      'V=-5 X=negative',
    ]);
  });

  it('uses bound variables from multiple relations in arithmetic filters', () => {
    const program = `
      score(alice, 20). score(bob, 14). baseline(team, 10).
      ahead(X) :- score(X, S), baseline(team, B), S > B + 5.
    `;
    expect(rows(run(program, 'ahead(X)'))).toEqual(['X=alice']);
    expect(rows(run(program, 'score(X, S), baseline(team, B), S - B >= 10'))).toEqual([
      'B=10 S=20 X=alice',
    ]);
  });

  it('fails closed on non-numeric, zero-divisor, and non-finite arithmetic', () => {
    expect(() => run('value(x, banana).', 'value(x, V), V + 1 > 0')).toThrow(
      EngineSafetyError
    );
    expect(() => run('value(x, 1).', 'value(x, V), V / 0 > 0')).toThrow(
      /division by zero/i
    );
    const huge = '9'.repeat(200);
    expect(() => run(`value(x, ${huge}).`, 'value(x, V), V * V > 0')).toThrow(
      /non-finite/i
    );
  });

  it('revalidates hand-built arithmetic ASTs at the evaluator boundary', () => {
    const ungrounded: Goal[] = [
      {
        op: '>',
        left: {
          kind: 'binary',
          op: '+',
          left: { type: 'var', name: 'Missing' },
          right: { type: 'num', value: 1 },
        },
        right: { type: 'num', value: 0 },
      },
    ];
    expect(() => evaluate([], ungrounded)).toThrow(/not grounded/i);

    let deep: ScalarExpression = { type: 'num', value: 1 };
    for (let index = 0; index < 65; index++) {
      deep = { kind: 'unary', op: '-', operand: deep };
    }
    expect(() =>
      evaluate([], [{ op: '=', left: deep, right: { type: 'num', value: -1 } }])
    ).toThrow(EngineLimitError);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        evaluate([], [
          {
            op: '>',
            left: { type: 'num', value },
            right: { type: 'num', value: 0 },
          },
        ])
      ).toThrow(/finite/i);
    }

    const invalidFact: Clause = {
      head: { predicate: 'value', args: [{ type: 'num', value: Number.NaN }] },
      body: [],
    };
    expect(() => evaluate([invalidFact], parseQuery('value(_)'))).toThrow(/finite/i);
    expect(() => serializeTerm({ type: 'num', value: Number.POSITIVE_INFINITY })).toThrow(
      /finite/i
    );
    expect(() =>
      literalMatches(
        { predicate: 'value', args: [{ type: 'wildcard' }] },
        { predicate: 'value', args: [{ type: 'num', value: Number.NaN }] }
      )
    ).toThrow(/finite/i);
  });

  it('keeps arithmetic filters out of derivation proof nodes', () => {
    const program = `
      age(alice, 30). threshold(adult, 18).
      adult(X) :- age(X, A), threshold(adult, T), A >= T + 0.
    `;
    expect(explain(program, 'adult(alice)')).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'adult',
            values: ['alice'],
            rule: 1,
            because: [
              { predicate: 'age', values: ['alice', 30] },
              { predicate: 'threshold', values: ['adult', 18] },
            ],
          },
        ],
      },
    ]);
  });
});

describe('evaluate: stratified negation', () => {
  const employment = `
    employee(alice).
    employee(bob).
    employee(carol).
    suspended(carol).
    desk(alice, 101).
    eligible(X) :- employee(X), \\+ suspended(X).
    employee_without_desk(X) :- employee(X), \\+ desk(X, _).
  `;

  it('filters on completed lower-stratum relations', () => {
    expect(rows(run(employment, 'eligible(X)'))).toEqual(['X=alice', 'X=bob']);
    expect(rows(run(employment, 'employee_without_desk(X)'))).toEqual([
      'X=bob',
      'X=carol',
    ]);
  });

  it('answers ground negative queries under the closed-world assumption', () => {
    expect(run(employment, '\\+ suspended(alice)')).toEqual([{}]);
    expect(run(employment, '\\+ suspended(carol)')).toEqual([]);
  });

  it('supports ground rules whose body is only an absence check', () => {
    expect(run('safe :- \\+ outage.', 'safe')).toEqual([{}]);
    expect(run('outage. safe :- \\+ outage.', 'safe')).toEqual([]);
    expect(explain('safe :- \\+ outage.', 'safe')).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'safe',
            values: [],
            rule: 1,
            because: [
              { negated: true, predicate: 'outage', pattern: [], stratum: 0 },
            ],
          },
        ],
      },
    ]);
  });

  it('combines same-stratum recursion with a lower-stratum negative filter', () => {
    const db = `
      edge(a, b). edge(b, c). edge(c, d). blocked(d).
      reachable(X, Y) :- edge(X, Y), \\+ blocked(Y).
      reachable(X, Y) :- edge(X, Z), reachable(Z, Y), \\+ blocked(Y).
    `;
    expect(rows(run(db, 'reachable(a, Y)'))).toEqual(['Y=b', 'Y=c']);
    expect(run(db, 'reachable(a, d)')).toEqual([]);
  });

  it('emits an atomic absence proof rather than inventing source support', () => {
    expect(explain(employment, 'eligible(bob)')).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'eligible',
            values: ['bob'],
            rule: 1,
            because: [
              { predicate: 'employee', values: ['bob'] },
              {
                negated: true,
                predicate: 'suspended',
                pattern: ['bob'],
                stratum: 0,
              },
            ],
          },
        ],
      },
    ]);
    expect(explain(employment, 'employee_without_desk(bob)')[0].proofs[0]).toMatchObject({
      predicate: 'employee_without_desk',
      because: [
        { predicate: 'employee', values: ['bob'] },
        {
          negated: true,
          predicate: 'desk',
          pattern: ['bob', null],
          stratum: 0,
        },
      ],
    });
  });

  it('evaluates successive negative dependencies in completed strata', () => {
    const db = `
      person(alice). person(bob). person(carol).
      suspended(carol). retired(bob).
      active(X) :- person(X), \\+ suspended(X).
      billable(X) :- active(X), \\+ retired(X).
      mention(X) :- billable(X).
    `;
    expect(rows(run(db, 'mention(X)'))).toEqual(['X=alice']);
    const proof = explain(db, 'mention(alice)')[0].proofs[0];
    expect(JSON.stringify(proof)).toContain('"predicate":"suspended"');
    expect(JSON.stringify(proof)).toContain('"predicate":"retired"');
  });

  it('counts absence nodes against the global proof budget', () => {
    expect(() => explain(employment, 'eligible(bob)', { maxProofNodes: 2 })).toThrow(
      EngineLimitError
    );
  });
});

describe('evaluate: limits', () => {
  it('throws EngineLimitError when base facts exceed maxFacts', () => {
    const db = `
      n(1). n(2). n(3).
    `;
    expect(() => run(db, 'n(X)', { maxFacts: 2 })).toThrow(EngineLimitError);
  });

  it('throws EngineLimitError when derived facts exceed maxFacts', () => {
    const db = `
      n(1). n(2). n(3). n(4). n(5).
      pair(X, Y) :- n(X), n(Y).
    `;
    expect(() => run(db, 'pair(X, Y)', { maxFacts: 10 })).toThrow(EngineLimitError);
  });
});

describe('evaluate: scalar query aggregation', () => {
  const employment = `
    works_at(alice, acme).
    works_at(bob, acme).
    works_at(carol, initech).
    suspended(bob).
  `;

  it('counts complete deduplicated result rows, including zero', () => {
    expect(
      runSpec(employment, 'count(*) as Count where works_at(Person, acme)')
    ).toEqual([{ Count: { type: 'num', value: 2 } }]);
    expect(
      runSpec(employment, 'count(*) as Count where works_at(alice, acme)')
    ).toEqual([{ Count: { type: 'num', value: 1 } }]);
    expect(
      runSpec(
        employment,
        'count(*) as Count where works_at(Person, nowhere)'
      )
    ).toEqual([{ Count: { type: 'num', value: 0 } }]);
    expect(
      runSpec(employment, 'count(*) as Count where works_at(Person, _), \\+ suspended(Person)')
    ).toEqual([{ Count: { type: 'num', value: 2 } }]);
  });

  it('aggregates recursive query results rather than derivation multiplicity', () => {
    const graph = `
      edge(a, b). edge(b, c). edge(a, c). edge(c, d).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;
    expect(runSpec(graph, 'count(*) as Count where path(a, Descendant)')).toEqual([
      { Count: { type: 'num', value: 3 } },
    ]);
    expect(
      runSpec(
        'person(alice). tag(alice, one). tag(alice, two).',
        'count(*) as Count where person(Person), tag(Person, _)'
      )
    ).toEqual([{ Count: { type: 'num', value: 2 } }]);
    expect(
      runSpec(employment, 'count(*) as Count where works_at(_, acme)')
    ).toEqual([{ Count: { type: 'num', value: 2 } }]);
  });

  it('applies arithmetic filters before exact aggregation', () => {
    const scores = 'score(alice, 20). score(bob, 14). baseline(team, 10).';
    expect(
      runSpec(
        scores,
        'count(*) as Count where score(Person, Points), baseline(team, Base), Points > Base + 5'
      )
    ).toEqual([{ Count: { type: 'num', value: 1 } }]);
  });

  it('computes sum over numeric rows and returns no row for empty input', () => {
    const scores = 'score(alice, 1.5). score(bob, -2). score(carol, 4).';
    expect(runSpec(scores, 'sum(Points) as Total where score(Player, Points)')).toEqual([
      { Total: { type: 'num', value: 3.5 } },
    ]);
    expect(
      runSpec(scores, 'sum(Points) as Total where score(nobody, Points)')
    ).toEqual([]);
  });

  it('computes numeric and atom extrema with deterministic tie positions', () => {
    const values = 'score(a, 2). score(b, 1). score(c, 1). name(zoe). name(amy).';
    expect(runSpec(values, 'min(Value) as Minimum where score(_, Value)')).toEqual([
      { Minimum: { type: 'num', value: 1 } },
    ]);
    expect(runSpec(values, 'max(Value) as Maximum where score(_, Value)')).toEqual([
      { Maximum: { type: 'num', value: 2 } },
    ]);
    expect(runSpec(values, 'min(Name) as First where name(Name)')).toEqual([
      { First: { type: 'atom', value: 'amy' } },
    ]);

    const proof = explainSpec(values, 'min(Value) as Minimum where score(Person, Value)');
    expect(proof[0].proofs[0]).toMatchObject({
      aggregated: true,
      op: 'min',
      input: 'Value',
      as: 'Minimum',
      value: 1,
      witnessPositions: [1, 2],
    });
  });

  it('fails closed for invalid scalar domains and non-finite sums', () => {
    expect(() =>
      runSpec('value(1). value(one).', 'min(Value) as Minimum where value(Value)')
    ).toThrow(EngineSafetyError);
    expect(() =>
      runSpec('value(one).', 'sum(Value) as Total where value(Value)')
    ).toThrow(EngineSafetyError);
    const huge = '9'.repeat(307);
    const overflowing = Array.from(
      { length: 20 },
      (_, index) => `value(${index}, ${huge}).`
    ).join(' ');
    expect(() =>
      runSpec(overflowing, 'sum(Value) as Total where value(Id, Value)')
    ).toThrow(EngineSafetyError);
  });

  it('does not silently reuse maxRows as the aggregate input cap', () => {
    const facts = Array.from({ length: 1005 }, (_, index) => `item(${index}).`).join(' ');
    expect(
      runSpec(facts, 'count(*) as Count where item(Item)', { maxRows: 1 })
    ).toEqual([{ Count: { type: 'num', value: 1005 } }]);
  });

  it('fails closed when aggregate input exceeds its dedicated cap', () => {
    expect(() =>
      runSpec('item(1). item(2). item(3).', 'count(*) as Count where item(Item)', {
        maxAggregateRows: 2,
      })
    ).toThrow(/aggregate input exceeded 2/i);
  });

  it('emits one bounded aggregate proof with ordered contributor evidence', () => {
    const result = explainSpec(
      employment,
      'count(*) as Count where works_at(Person, acme)'
    );
    expect(result).toEqual([
      {
        bindings: { Count: { type: 'num', value: 2 } },
        proofs: [
          {
            aggregated: true,
            op: 'count',
            input: '*',
            as: 'Count',
            value: 2,
            contributors: [
              {
                bindings: { Person: { type: 'atom', value: 'alice' } },
                proofs: [{ predicate: 'works_at', values: ['alice', 'acme'] }],
              },
              {
                bindings: { Person: { type: 'atom', value: 'bob' } },
                proofs: [{ predicate: 'works_at', values: ['bob', 'acme'] }],
              },
            ],
          },
        ],
      },
    ]);
    expect(() =>
      explainSpec(employment, 'count(*) as Count where works_at(Person, acme)', {
        maxProofNodes: 2,
      })
    ).toThrow(EngineLimitError);
  });

  it('separates exact aggregate evaluation from the smaller explanation cap', () => {
    const facts = Array.from({ length: 257 }, (_, index) => `item(${index}).`).join(' ');
    const query = 'count(*) as Count where item(Item)';
    expect(runSpec(facts, query)).toEqual([{ Count: { type: 'num', value: 257 } }]);
    expect(() => explainSpec(facts, query)).toThrow(
      /aggregate proof exceeded 256 contributor rows/i
    );
    expect(
      explainSpec(facts, query, { maxAggregateProofRows: 257 })[0].proofs[0]
    ).toMatchObject({ aggregated: true, value: 257 });
  });
});

describe('evaluateWithProof', () => {
  it('returns a leaf proof for a base fact query', () => {
    expect(explain('works_at(rahul, acme).', 'works_at(rahul, acme)')).toEqual([
      {
        bindings: {},
        proofs: [{ predicate: 'works_at', values: ['rahul', 'acme'] }],
      },
    ]);
  });

  it('returns ordered proofs for multi-goal queries', () => {
    const db = `
      works_at(rahul, acme).
      lives_in(rahul, sydney).
    `;

    expect(explain(db, 'works_at(X, acme), lives_in(X, sydney)')).toEqual([
      {
        bindings: { X: { type: 'atom', value: 'rahul' } },
        proofs: [
          { predicate: 'works_at', values: ['rahul', 'acme'] },
          { predicate: 'lives_in', values: ['rahul', 'sydney'] },
        ],
      },
    ]);
  });

  it('returns a joined rule proof', () => {
    const db = `
      works_at(rahul, acme).
      works_at(maya, acme).
      colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
    `;

    expect(explain(db, 'colleague(rahul, maya)')).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'colleague',
            values: ['rahul', 'maya'],
            rule: 1,
            because: [
              { predicate: 'works_at', values: ['rahul', 'acme'] },
              { predicate: 'works_at', values: ['maya', 'acme'] },
            ],
          },
        ],
      },
    ]);
  });

  it('returns a recursive proof tree that matches the SQLite structure', () => {
    const db = `
      edge(a, b).
      edge(b, c).
      edge(c, d).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;

    expect(explain(db, 'path(a, d)')).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'path',
            values: ['a', 'd'],
            rule: 2,
            because: [
              { predicate: 'edge', values: ['a', 'b'] },
              {
                predicate: 'path',
                values: ['b', 'd'],
                rule: 2,
                because: [
                  { predicate: 'edge', values: ['b', 'c'] },
                  {
                    predicate: 'path',
                    values: ['c', 'd'],
                    rule: 1,
                    because: [{ predicate: 'edge', values: ['c', 'd'] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps the deterministic first witness across repeated runs', () => {
    const db = `
      edge(a, b).
      edge(b, d).
      edge(a, c).
      edge(c, d).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;

    const runs = Array.from({ length: 5 }, () => explain(db, 'path(a, d)'));
    expect(new Set(runs.map((run) => JSON.stringify(run))).size).toBe(1);
    expect(runs[0]).toEqual([
      {
        bindings: {},
        proofs: [
          {
            predicate: 'path',
            values: ['a', 'd'],
            rule: 2,
            because: [
              { predicate: 'edge', values: ['a', 'b'] },
              {
                predicate: 'path',
                values: ['b', 'd'],
                rule: 1,
                because: [{ predicate: 'edge', values: ['b', 'd'] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps the first rule as witness when duplicate rules derive the same tuple', () => {
    const db = `
      base(a).
      pick(X) :- base(X).
      pick(X) :- base(X).
    `;
    expect(explain(db, 'pick(a)')[0].proofs[0]).toMatchObject({ rule: 1 });
  });

  it('enforces the proof depth cap during serialization', () => {
    const db = `
      edge(a, b).
      edge(b, c).
      edge(c, d).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;

    expect(() => explain(db, 'path(a, d)', { maxProofDepth: 2 })).toThrow(EngineLimitError);
  });

  it('enforces the proof node cap for a single joined proof', () => {
    const db = `
      works_at(rahul, acme).
      works_at(maya, acme).
      colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
    `;

    expect(() => explain(db, 'colleague(rahul, maya)', { maxProofNodes: 2 })).toThrow(
      EngineLimitError
    );
  });

  it('enforces the proof node cap across emitted rows', () => {
    const db = `
      works_at(rahul, acme).
      works_at(maya, acme).
    `;

    expect(() => explain(db, 'works_at(X, acme)', { maxProofNodes: 1 })).toThrow(
      EngineLimitError
    );
  });
});

describe('materializeWithProof', () => {
  it('returns base and derived facts with proofs', () => {
    const db = `
      edge(a, b).
      edge(b, c).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `;

    const facts = materializeWithProof(parseProgram(db));
    const byKey = new Map(
      facts.map((fact) => [`${fact.predicate}(${fact.values.join(',')})`, fact] as const)
    );

    expect(byKey.get('edge(a,b)')).toEqual({
      predicate: 'edge',
      values: ['a', 'b'],
      derived: false,
      proof: { predicate: 'edge', values: ['a', 'b'] },
    });
    expect(byKey.get('path(a,c)')).toEqual({
      predicate: 'path',
      values: ['a', 'c'],
      derived: true,
      proof: {
        predicate: 'path',
        values: ['a', 'c'],
        rule: 2,
        because: [
          { predicate: 'edge', values: ['a', 'b'] },
          {
            predicate: 'path',
            values: ['b', 'c'],
            rule: 1,
            because: [{ predicate: 'edge', values: ['b', 'c'] }],
          },
        ],
      },
    });
  });

  it('enforces the proof node cap across materialized facts', () => {
    const db = `
      edge(a, b).
      edge(b, c).
    `;

    expect(() => materializeWithProof(parseProgram(db), { maxProofNodes: 1 })).toThrow(
      EngineLimitError
    );
  });
});
