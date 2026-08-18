# Migrating to 0.42

Version 0.42 is additive. Existing memories, rules, proofs, graphs, paths, queries, and
stored formats require no migration.

`connectKnowledgeGraph`, CLI `connect`, and MCP `connect_knowledge_graph` now accept an
opt-in `includeDerived` / `--include-derived` mode. The default remains explicit stored
facts only.

When enabled, Remembero materializes the existing bounded Datalog fixpoint only for path
discovery. Every claim on a selected shortest path is then independently explained
through the source-aware proof engine. Results add:

- `derived` and optional `rule` on path segments;
- deduplicated `claimProofs` for every selected path claim;
- only the authored rules actually used by those proofs; and
- proof support, absence, aggregate, source, identity, and trust nodes in the path graph.

Derived traversal can make a rule conclusion a shorter semantic hop than its supporting
explicit-fact chain. The proof remains attached so the shortcut is never an unexplained
or persisted graph edge.
