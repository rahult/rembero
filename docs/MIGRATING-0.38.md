# Migrating to 0.38

Version 0.38 is additive. Existing rules, queries, proofs, graphs, counters, and stored
formats require no migration.

New interfaces are:

- library: `profileKnowledge(...)` and profile options/result/reduction types;
- CLI: `profile <query>` and `--compare-scan`; and
- MCP: `profile_query` with optional `compareFullScan`.

No timing field is introduced. Consumers should compare deterministic counters rather
than interpreting them as elapsed cost across hosts.
