# Scalar query aggregation

Remembero 0.3 added exact scalar reduction over portable-engine query results:

```prolog
?- count(*) as Count where works_at(Person, acme).
?- sum(Hours) as Total where logged_hours(Person, Hours).
?- min(Year) as Earliest where birth_year(Person, Year).
?- max(Score) as Highest where score(Person, Score).
```

Exactly one operator is allowed. A terminal query result contains only the fresh variable
named after `as`; terminal query syntax deliberately has no grouping keys.

Version 0.20 additionally permits the same reduction after `:-` in a stored rule. The
non-output head variables become group keys and the result is a reusable derived
predicate. See [reusable aggregate rules](RULE-AGGREGATION.md).

## Result semantics

The `where` goals run through the normal stratified, semi-naive engine. Aggregation then
consumes the complete logical solution rows in their deterministic query order. Distinct
wildcard matches remain distinct contributors even when they expose identical bindings:

Arithmetic comparisons may filter the `where` rows before reduction, for example
`count(*) as Count where score(Person, Points), Points > 10 + 5`. The aggregate input
itself remains a bound variable (or `*` for `count`), never an arithmetic expression.

- `count(*)` counts result rows and returns `0` for an empty result.
- `sum(X)` accepts numbers only and returns no row for an empty result.
- `min(X)` and `max(X)` accept either all numbers or all atoms. Mixed scalar types fail
  closed, and an empty result returns no row.
- Non-finite sums fail closed.

`employee(Person)` and `employee(_)` both count every distinct employee tuple. Named
variables remain preferable in explanations because contributor bindings then identify
the counted entities directly.

## Safety and limits

Aggregate queries require at least one positive relational goal. `sum`, `min`, and `max`
take a variable bound by a positive goal, and the output alias must be fresh.

`maxRows` limits returned rows and is never used as an aggregate input shortcut. Exact
aggregation inspects up to `maxAggregateRows` candidate relational solutions (100,000 by
default), including distinct wildcard solutions that expose the same binding. Crossing
that cap throws `EngineLimitError`; Remembero never returns a partial count, sum, or
extremum.

Plain aggregation and explanation have separate limits. Exact `query` can consume the
full aggregate input cap, while `explain` retains at most `maxAggregateProofRows` (256 by
default) complete contributors. Larger explanations fail closed instead of emitting an
unbounded proof/graph payload; callers can raise the proof-row cap explicitly. CLI and
MCP responses and CLI output also have a 16 MiB serialization boundary.

## Library API

The existing relational APIs remain unchanged. Aggregate-aware callers use the additive
query-spec layer:

```ts
import {
  evaluateQuerySpec,
  evaluateQuerySpecWithProof,
  parseProgram,
  parseQuerySpec,
} from 'rembero';

const clauses = parseProgram('score(alice, 3). score(bob, 5).');
const query = parseQuerySpec('max(Points) as Highest where score(Person, Points)');

evaluateQuerySpec(clauses, query);          // [{ Highest: { type: 'num', value: 5 } }]
evaluateQuerySpecWithProof(clauses, query); // same binding plus aggregate evidence
```

## Explanations and graph

An aggregate proof records the operator, input, alias, scalar value, and every ordered
contributor row with its ordinary derivation or absence proofs. `min` and `max` also
record every tied extremum in `witnessPositions`. Existing proof depth and node budgets
include the aggregate node and all contributor proofs.

The personal knowledge graph projects this as an `aggregate` node. The final result has
an `answers` edge to it; ordered `input` edges connect it to contributor result nodes,
and `witness` edges identify all deterministic min/max ties. Provenance remains attached
to the contributor claims, never fabricated on the aggregate itself.

## SQLite boundary

The Node `DatalogDatabase` adapter and the `sqlite-query`/`sqlite-explain` commands evaluate
scalar aggregates over a deterministic snapshot of referenced SQLite tables. The stock
loadable extension scalar functions and `datalog_sql` do not accept aggregate query or
rule syntax.
See [SQLite determinism and parity](SQLITE-DETERMINISM.md).
