# Exact recorded knowledge diff

Rembero 0.26 compares two authoritative global journal positions. It answers both “what
changed?” and “what did that change affect?” without deriving order from timestamps or
reading the two endpoints across different concurrent journal states.

## Use

```bash
rembero diff 17 23
rembero diff 17 23 --query 'status(mira, State)'
rembero diff 17 23 --trust include_tentative
```

The library exposes `diffRecordedKnowledge(store, from, to, options)`. MCP exposes
`diff_recorded_knowledge`. `from` must not exceed `to`; sequence zero is the empty state.
Both endpoints retain their own sequence, complete journal length, and selected
namespaces.

## Direct clause and provenance changes

Clauses are compared by canonical Datalog identity:

- `added` and `removed` distinguish facts, rules, integrity constraints, and explicit
  identity metadata;
- alpha-equivalent rules are one semantic identity; and
- `sourceChanged` retains before/after authored spelling and complete durable sources when
  semantics stay the same but provenance or representation changes.

This makes a tentative-to-accepted promotion informative in either trust view. Accepted
mode sees a fact addition. `include_tentative` sees the same fact remain while its source
changes from `trust: tentative` to an accepted trust action.

Identity declarations are reported explicitly even though normal reasoning views hide
their reserved predicates. Tentative declarations are not exposed as raw metadata:
default trust remains isolated, while `include_tentative` compares their projected facts.

An audit-only journal entry still advances `journalEntriesTraversed`, but `changed` stays
false and every semantic delta remains empty.

## Consequence changes

Every diff includes:

- topology before/after counts plus added, removed, and changed predicate/rule/policy
  nodes and dependency edges;
- open-input, open-negated-input, and recursive-component changes;
- complete bounded integrity results for both endpoints with introduced and resolved
  violation identities and proof rows; and
- when `--query` is present, complete before/after explanation results plus added,
  removed, evidence-changed, and unchanged result rows.

Topology and query graphs stay in their existing domains. The diff does not merge them
into an ambiguous cross-snapshot graph or apply one node selector to two different graph
states.

## Coherence and completeness

`MemoryStore.recordedSnapshots(...)` holds the mutation and journal boundaries across the
whole batch. A concurrent supported writer or audit append therefore cannot land between
the two diff endpoints. Each snapshot still performs the normal full replay/current-file
reconciliation and fails with `IncompleteHistoryError` on drift, corruption, missing
segments, unsupported operations, or incomplete history.

Identity and trust are projected independently at both positions before semantic
comparison. Source timestamps remain evidence fields only; they never order or select
changes.

## Bounds

The diff fails closed above 10,000 combined added, removed, or source-changed clauses.
Existing 32-namespace, topology, integrity, proof, query-row, journal, input, and 16 MiB
CLI/MCP output limits apply. Snapshot batching is separately capped at 64 positions; the
diff uses exactly two.
