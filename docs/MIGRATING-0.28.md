# Migrating to 0.28

Version 0.28 is additive. Existing facts, rules, constraints, queries, topology, why-not,
repair, diff, snapshots, and recall behavior require no migration.

New interfaces are:

- library: `auditKnowledgeRules(...)`, audit finding/status/graph/options/result types, and
  `MAX_RULE_AUDIT_FINDINGS`;
- CLI: `audit-rules [predicate]`, reusing topology `--direction` and recorded
  `--as-of-sequence`; and
- MCP: `audit_rules`.

CLI automation should account for exit `2`, which means a complete audit succeeded and
returned one or more warning findings. Informational-only `advisory` results exit `0`.
This matches integrity/conflict inspection semantics without turning an advisory into a
runtime error.
