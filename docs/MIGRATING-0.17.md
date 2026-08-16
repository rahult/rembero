# Migrating to 0.17

Version 0.17 is additive and requires no migration of `.dl` files, journals, snapshots,
MCP configuration, or SQLite tables.

Portable evaluation now lazily indexes a predicate's first argument when it is ground or
already bound. Existing query rows, derivation proofs, source order, graph projections,
limits, and errors remain unchanged.

Library additions:

- `EvaluateOptions.relationIndex`: `auto` by default, or `off` for an unindexed parity or
  benchmark control;
- `EvaluateOptions.metrics`: an optional mutable `EvaluationMetrics` object populated
  with deterministic relation lookup and candidate-work counters;
- exported `EvaluationMetrics` type.

No application needs to set these options for normal use. See
[the deterministic indexing contract](ENGINE-INDEXING.md) and run `npm run bench:engine`
to reproduce the scale evidence.
