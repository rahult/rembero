# Migrating to 0.48

Version 0.48 is additive. Existing knowledge, checks, rules, health component tools, and
stored formats are unchanged.

New interfaces are:

- library `inspectKnowledgeHealth(...)` and health result/finding types;
- CLI `health` with optional `--check-suite` and existing view options; and
- MCP `knowledge_health`.

CLI health exit codes are `0` healthy, `2` review required, and `3` integrity violations.
