# Migrating to 0.35

Version 0.35 is additive. Existing facts, rules, constraints, query results, prompts,
graphs, snapshots, and package formats require no migration.

New interfaces are:

- library: suite parse/run functions, suite/check/expectation/result/options types, and
  suite resource constants;
- CLI: `test-knowledge <file>` and `--include-passing-evidence`; and
- MCP: `run_knowledge_checks`.

CLI automation should handle exit `2` as a successfully executed failing suite, analogous
to integrity and rule-audit warning exits. The suite file is read-only and symbolic links
or non-regular files are refused.
