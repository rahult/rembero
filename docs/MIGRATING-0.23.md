# Migrating to 0.23

Version 0.23 is additive. Existing namespace files, journals, checkpoint segments,
snapshots, queries, rules, constraints, trust state, and default recall behavior require
no migration.

New interfaces are:

- library: `simulateKnowledge(...)`, `MemoryStore.knowledgeSnapshot(...)`,
  counterfactual result/options types, and the two batch-limit constants;
- CLI: `what-if <query>`, repeatable `--assume <facts>`, and repeatable
  `--without <pattern>`; and
- MCP: `what_if`.

`MemorySource` may now contain additive `hypothetical: true` inside a counterfactual
result. Such a source is never durable and its timestamp is a deterministic sentinel,
not temporal evidence. Consumers that reject unknown source fields should allow this
property before upgrading.

The simulation is current-view only. Recorded snapshots remain available on ordinary
read surfaces, while a later release may add an explicit historical counterfactual model
if a concrete use case justifies its mutation and namespace semantics.
