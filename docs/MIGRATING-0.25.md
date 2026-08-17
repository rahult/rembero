# Migrating to 0.25

Version 0.25 is additive. Existing facts, rules, constraints, snapshots, journals,
checkpoints, query graphs, why-not evidence, and recall behavior require no migration.

New interfaces are:

- library: `analyzeKnowledgeTopology(...)`, topology result/node/edge/selection types,
  direction type, and topology limit constants;
- CLI: `topology [predicate]` and optional `--direction upstream|downstream|both`; and
- MCP: `knowledge_topology`.

The result uses a new topology graph rather than extending query explanation node/edge
unions. This preserves existing graph selectors and consumers. Topology focus is a
predicate dependency selection, while query graph selection remains result/support/node
navigation.

Current and recorded topology may expose durable rule or policy `sources` plus aggregate
definition namespace/operation counts on predicates. These are existing redacted
`MemorySource` records; no new persistent provenance format is introduced.
