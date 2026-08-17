# Explicit deterministic relational projection

Rembero 0.47 distinguishes variables that answer a query from variables used only to
join, compare, or constrain it. This removes model discretion from the final binding
shape without weakening Datalog reasoning.

## Syntax

```prolog
select Grandchild where parent(alice, Parent), parent(Parent, Grandchild)
select City where dentist(rahul, Dentist), lives_in(Dentist, City)
select Person, City where employee(Person), lives_in(Person, City)
```

The optional `?-` prefix and trailing period remain accepted. Projection variables are
ordered, unique, and must be bound by a positive relation. Variables bound only by a
comparison or negated goal are rejected by the existing range-restriction rules.

Legacy relational queries remain unchanged and return every bound variable. Ground yes/no
queries need no projection and still return one empty binding when true. Scalar aggregates
retain their existing explicit output alias syntax.

## Evaluation semantics

Projection happens at the solver result boundary before row identity and row limits are
applied. Consequently:

- helper variables never appear in returned bindings;
- solutions differing only in helper bindings collapse into one projected row;
- `maxRows` counts unique projected answers, not internal join expansions;
- selected variable order becomes stable binding order; and
- missing or unbound projected variables fail closed.

Default proof mode retains the first deterministic complete witness for each projected
row. Alternative-proof mode merges distinct helper-variable solution branches into that
same answer row and applies the existing complete bounded proof enumeration contract.

## Recall authority

The grounded natural-language prompt now requires every variable-bearing relational query
to use `select`. Only variables whose values answer the user's question may be selected.
For example, a dentist join selects `City`, not the intermediate `Dentist` entity.

This is stronger than asking a model to prefer a derived predicate: the model may safely
inline a valid multi-goal relation while the local parser and evaluator retain authority
over which columns can become an answer. Baseline prompt evaluation remains available,
and legacy unprojected output remains parseable for backward compatibility.

Grounded validation also rejects any unprojected output containing more than one distinct
variable and uses the existing single correction retry. This fail-closed guard catches
provider drift while preserving legacy single-variable integrations and baseline evals.

## Interface parity

Projection is part of `QuerySpec` and canonical `serializeQuerySpec`. It is preserved by
canonical entity rewriting and works through portable evaluation, explanation graphs,
why-not, counterfactuals, checks, coverage, profiling, CLI/MCP, SQLite portable execution
and planning, recall scoring, and deterministic answer rendering.

SQLite native scalar compilation remains rule-only; all raw relational queries already
use the portable snapshot boundary. Plans report only selected result variables.
