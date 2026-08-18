# Arithmetic comparison expressions

Remembero 0.4 adds deterministic numeric expressions to comparison filters in the portable
engine. Arithmetic never constructs stored or derived values; it only decides whether a
grounded candidate row survives:

```prolog
older_by_five(X, Y) :- age(X, A), age(Y, B), A > B + 5.
eligible(X) :- score(X, S), baseline(X, B), (S - B) * 2 >= 10.
?- measurement(Name, Value), Value / 2 < -Limit.
```

## Grammar and precedence

Both sides of `=`, `!=`, `<`, `>`, `<=`, and `>=` accept scalar expressions. Supported
numeric operators are:

1. unary `+` and `-`;
2. multiplication `*` and division `/`;
3. addition `+` and subtraction `-`.

Parentheses override precedence. Binary operators of the same precedence associate to
the left, so `20 / 2 / 2` is `(20 / 2) / 2`. Canonical serialization retains parentheses
whenever removing them could change the exact expression tree or IEEE-754 evaluation
order.

Arithmetic is deliberately filter-only. Expressions are rejected in facts, relation
arguments, rule heads, negated literals, and aggregate inputs. Every expression variable
must be grounded by an earlier positive relational goal, preserving range restriction and
the finite Datalog universe.

## Numeric and failure semantics

Operations use finite JavaScript numbers (IEEE-754 binary64), matching Remembero's existing
numeric fact and aggregate domain. Evaluation is deterministic for a fixed ordered
program and runtime:

- every arithmetic operand must resolve to a number;
- division by positive or negative zero fails closed;
- a non-finite intermediate or final result fails closed;
- negative zero is canonicalized to zero;
- arithmetic never binds a variable or silently coerces an atom;
- bare atom-to-atom and mixed-type comparisons keep their pre-0.4 behavior when neither
  operand contains arithmetic.

Invalid arithmetic raises `EngineSafetyError` rather than silently accepting a partial or
coerced result. Expression trees are capped at 64 levels and 256 nodes per comparison.
Text parsing raises `ParseError` when those bounds are crossed; hand-built ASTs are
checked again during evaluation and raise `EngineLimitError`.

## Proofs, aggregation, and recall

Comparisons remain proof filters rather than claims. A successful derived fact retains
the positive and absence proof steps that grounded the rule; its canonical rule text
shows the arithmetic expression. No source is invented for a calculation.

Arithmetic may filter an aggregate's `where` goals before exact reduction:

```prolog
?- count(*) as Count where score(Person, Points), Points > 10 + 5.
```

Natural-language recall is taught the same grammar for explicit numeric offsets and
thresholds. The parser still validates all generated queries before evaluation.

## SQLite boundary

The Node `DatalogDatabase` adapter and the `sqlite-query`/`sqlite-explain` commands evaluate
arithmetic comparisons over a deterministic snapshot of referenced SQLite tables. The
stock loadable extension scalar functions and `datalog_sql` retain single-term comparisons
only and reject arithmetic expressions. See
[SQLite determinism and parity](SQLITE-DETERMINISM.md).
