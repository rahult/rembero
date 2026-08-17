# Reusable aggregate rules

Version 0.20 lets an exact reduction become an ordinary derived predicate. Counts,
totals, minima, and maxima can now be reused by later rules, integrity policy, recall,
and graph explanations instead of existing only as terminal query results.

```prolog
team_size(Team, Count) :-
  count(*) as Count where member(Team, Person).

team_total(Team, Total) :-
  sum(Points) as Total where score(Team, Person, Points).

large_team(Team) :- team_size(Team, Count), Count >= 5.
```

The syntax deliberately reuses scalar query aggregation after `:-`. Each aggregate rule
contains exactly one `count`, `sum`, `min`, or `max` reduction and one positive `where`
body.

## Grouping and empty input

The aggregate output variable must appear exactly once in the rule head and nowhere in
the body. Every other head variable is a deterministic group key and must be bound by a
positive body relation. Constants and repeated non-output head terms retain ordinary
Datalog head semantics.

For each distinct ordered group-head tuple, Rembero reduces all matching body solutions
and inserts one derived fact. Contributor order follows deterministic body evaluation.

- `count(*)` returns the number of complete body solutions;
- `sum(Value)` requires finite numeric values;
- `min(Value)` and `max(Value)` require one scalar type and retain every tied witness;
- a global `count(*)` rule with no body solutions derives zero;
- an empty grouped rule has no group and derives no fact;
- empty `sum`, `min`, and `max` rules derive no fact.

Aggregate inputs are exact solution rows, not derivation multiplicity. Relations retain
set semantics before they enter the aggregate body.

## Stratification and termination

Every aggregate dependency is strict: the aggregate head is assigned a higher stratum
than every relation in its body. An aggregate rule runs once after all input strata reach
their fixpoint. Ordinary rules may consume its derived facts, and another aggregate rule
may reduce those facts in a later stratum.

Any dependency cycle containing aggregation is rejected before evaluation. Recursive
relations may be aggregated after their fixpoint, but an aggregate cannot recursively
create or change its own input domain.

## Proofs, sources, and graph evidence

An aggregate-derived fact retains its ordinary predicate, values, and rule number plus a
nested `aggregate` proof containing:

- operator, input, output variable, and exact value;
- every ordered contributor binding and proof vector;
- tied witness positions for `min` and `max`.

Contributor facts keep their durable namespace/source metadata and canonical identity
projection. The query-scoped graph connects the derived claim to a scoped aggregate node,
then through ordered `input` and `witness` edges to contributor result and claim nodes.
Empty aggregate evidence is scoped to its derived claim so unrelated zero-count rules do
not collapse into one graph node.

`maxAggregateRows` caps complete input inspection per aggregate rule.
`maxAggregateProofRows` separately caps retained contributor evidence. Exceeding either
bound fails closed. Expanded alternative-proof enumeration through an aggregate-derived
predicate is rejected explicitly; the exact first proof remains available.

The evaluator revalidates aggregate-rule shape, range restriction, positive input,
operator/input form, fresh output, and grouped head bindings even when a library caller
constructs `AggregateRuleClause` objects directly instead of using `parseProgram`.

## Knowledge and interface behavior

Aggregate rules are stored as ordinary readable `.dl` clauses, canonicalized for
alpha-equivalent deduplication, journaled, included in recorded snapshots, and shown in
rule/schema summaries. Canonical entity projection preserves the aggregate specification.

Derived aggregate predicates can be queried through the library, CLI, MCP, and natural
language recall. When a question explicitly asks for the same reduction and the schema
already contains a matching aggregate-derived predicate, recall may query that predicate
directly instead of reducing its already-aggregated rows again. A group key must be named,
requested distributively (`each`, `per`, or `every`), or bound by an auxiliary positive
goal; asking for the number of groups still uses a terminal scalar aggregate.

Integrity constraints and atomic enforcement can consume aggregate-derived facts:

```prolog
:- team_size(Team, Count), Count > 12.
```

The aggregate rule does not itself assert policy; only an explicit headless constraint
defines a forbidden state.

## SQLite boundary

`datalog_query` and `datalog_explain` execute aggregate rules through the bounded portable
bridge over a deterministic SQLite read snapshot. `datalog_sql` still rejects aggregation
because a reusable, stratified aggregate program cannot be represented as the existing
single native `SELECT` compilation.

No aggregate materialization or incremental sidecar is persisted. Every read derives the
same bounded relation from the selected authoritative facts and rules.
