# Migrating to 0.41

Version 0.41 is additive. Existing memories, rules, proofs, graphs, queries, and stored
formats require no migration.

New interfaces are:

- library: `connectKnowledgeGraph(...)` and its path option/result types;
- CLI: `connect <from> <to>` with bounded path, claim, numeric endpoint, namespace,
  identity, trust, and recorded-view options; and
- MCP: `connect_knowledge_graph`.

`BrowseKnowledgeGraphSelection` now includes additive `frontierExhausted` evidence. It is
true only when no unselected explicit claim remains adjacent to the final entity frontier.
Existing browse selection fields and graph shapes are unchanged.

Path results contain explicit stored facts only. Rules and inferred claims still require
query/explain, so no existing graph-authority boundary changes.
