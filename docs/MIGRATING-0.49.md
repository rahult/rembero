# Migrating to 0.49

Version 0.49 is additive. Existing memory proposals and applications without a suite keep
their v0.48 behavior.

`ProposeRememberOptions` and MCP `propose_memory` add optional `checkSuite`; CLI
`propose-memory` accepts `--check-suite <file>`. Effective proposals embed the normalized
suite and preview `checkDelta`.

`applyMemoryProposal` and MCP/CLI application automatically re-run a bound suite. Failure
raises structured `memory_change_checks_failed`; CLI exits `2` without mutation. Successful
results add `checks`.
