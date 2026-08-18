# Deterministic query work profiling

Remembero 0.38 profiles rule/query work using deterministic engine counters rather than
wall-clock timing. The result retains the ordinary rows, proofs, sources, rules, and graph
so optimization evidence cannot drift from semantics.

## Use

```bash
remembero profile 'relevant(X, Y)'
remembero profile 'path(a, Y)' --compare-scan
remembero profile 'count(*) as Count where employee(Person)' --as-of-sequence 17
```

The library exposes `profileKnowledge(...)`. MCP exposes `profile_query`.

## Counters

- `relationLookups`: relational goals considered during fixpoint/query solving;
- `indexedRelationLookups`: lookups whose bound first argument used the lazy relation
  index;
- `indexFactsProcessed`: facts read once while constructing those lazy indexes; and
- `candidateFactsVisited`: candidate tuples examined by unification.

Counters are integers derived from authored goal order and the selected logical program.
There are no durations, timestamps, CPU estimates, allocation counts, or host-dependent
cost claims.

## Full-scan comparison

`--compare-scan` / `compareFullScan` executes the same explanation twice:

1. normal lazy insertion-ordered relation indexes;
2. `relationIndex: "off"`, scanning each relation in insertion order.

The profiler serializes both complete explanation objects and fails if they differ. A
successful comparison returns `equivalent: true`, both counter sets, and:

- `candidateFactsAvoided = scan visits - indexed visits`; and
- `candidateVisitRatio = scan visits / indexed visits`, rounded to four decimals.

The ratio is `1` when both paths visit zero candidates and `null` when the indexed path
visits zero while scan visits more (an unbounded/infinite ratio cannot be represented as
JSON). Negative avoidance is possible on tiny workloads and is reported honestly.

## Views and bounds

Profiling supports relational/aggregate queries, recursion, proof limits, graph selectors,
canonical identity, tentative trust, namespaces, and exact recorded snapshots. It is
read-only and uses the same coherent selected clause/source view as `explain`.

Both runs retain ordinary evaluator fact, iteration, row, aggregate, proof, graph,
namespace/history, input, and 16 MiB output limits. Comparison doubles deterministic
evaluation work by design and is opt-in.

Profiling identifies engine work, not a database cost plan. Use v0.37 `sqlite-plan` for
SQLite routing/schema inspection and SQLite's own `EXPLAIN QUERY PLAN` for SQL cost detail.
