# Stratified negation

Remembero's portable Datalog engine supports closed-world negation over relational
literals:

```prolog
employee(alice).
employee(bob).
suspended(bob).

available(X) :- employee(X), \+ suspended(X).
```

`available(X)` returns `alice`. The negative goal means “no matching `suspended(X)` fact
or derivation exists after its lower stratum is complete.” It does not mean that an
external source proved Alice is not suspended.

## Safety

- Only relational literals can be negated: `\+ suspended(X)`.
- Every named variable in a comparison or negated literal must be bound by an earlier
  positive relation. `employee(X), \+ suspended(X)` is safe; `\+ suspended(X),
  employee(X)` is rejected.
- Wildcards are existential patterns, so `employee(X), \+ desk(X, _)` selects known
  employees with no stored desk assignment.
- Ground negative queries are valid. `\+ suspended(alice)` returns one empty binding row
  when the relation is absent and no rows when it is present.
- Negation never binds variables.

## Stratification and termination

For every rule dependency, the head predicate is assigned a stratum at least as high as
a positive dependency and strictly higher than a negative dependency. Programs with a
dependency cycle containing negation fail before evaluation:

```prolog
p :- \+ q.
q :- \+ p.  % rejected
```

Strata execute from low to high. Positive recursion within one stratum continues to use
bounded semi-naive fixpoint evaluation. Negative goals can therefore inspect only a
completed lower-stratum relation, preserving deterministic finite evaluation.

## Explanations

A successful negative goal emits an atomic absence proof:

```json
{
  "negated": true,
  "predicate": "suspended",
  "pattern": ["alice"],
  "stratum": 0
}
```

`null` represents a wildcard argument. Absence proofs count toward proof depth and node
budgets. In the personal knowledge graph they become `absence` nodes connected in the
same ordered proof sequence as positive support, but they have no source metadata because
absence is a database-state check rather than an asserted fact.

## SQLite boundary

The Node `DatalogDatabase` adapter and the `sqlite-query`/`sqlite-explain` commands evaluate
stratified negation over a deterministic snapshot of referenced SQLite tables. The stock
loadable extension scalar functions and `datalog_sql` remain positive-only and reject
`\+` explicitly. See [SQLite determinism and parity](SQLITE-DETERMINISM.md).
