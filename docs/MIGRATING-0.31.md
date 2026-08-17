# Migrating to 0.31

Version 0.31 is additive. Existing facts, rules, constraints, recall, query, graph,
topology, journal, and snapshot behavior require no migration.

New interfaces are:

- library: `searchKnowledge(...)`, result/reason/graph/options/kind types, and local-search
  limit constants;
- CLI: `search <text>`, repeatable `--kind`, and `--search-limit`; and
- MCP: `search_knowledge`.

Search scores are intentionally local fixed heuristics and are not added to recall
answers, query proofs, or stored knowledge. Consumers should use `results[].reasons` rather
than treating the numeric score as confidence or truth probability.
