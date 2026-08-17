# Migrating to 0.32

Version 0.32 is additive. Existing facts, rules, constraints, query graphs, topology,
search, recall, journal, and snapshot behavior require no migration.

New interfaces are:

- library: `browseKnowledgeGraph(...)`, browse options/selection/result types, and graph
  browse limit constants;
- CLI: `browse [entity]`, `--predicate`, `--browse-depth`, `--claim-limit`, and
  `--focus-number`; and
- MCP: `browse_knowledge_graph`.

The result graph deliberately reuses explanation claim/entity/argument shapes but contains
explicit facts only. Consumers must not interpret a missing derived claim as a failed
rule; run `explain` or `why-not` for inference.
