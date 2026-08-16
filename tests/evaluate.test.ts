import { describe, it, expect } from 'vitest';
import {
  evaluate,
  evaluateWithProof,
  parseProgram,
  parseQuery,
  serializeTerm,
  EngineLimitError,
  type Bindings,
  materializeWithProof,
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

function run(program: string, query: string, options?: { maxFacts?: number }) {
  return evaluate(parseProgram(program), parseQuery(query), options);
}

function explain(
  program: string,
  query: string,
  options?: { maxFacts?: number; maxProofDepth?: number; maxProofNodes?: number }
) {
  return evaluateWithProof(parseProgram(program), parseQuery(query), options);
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
