# Migrating to 0.43

Version 0.43 is additive. Existing memories, rules, counterfactual calls, proofs, graphs,
and stored formats require no migration.

`simulateKnowledge` and MCP `what_if` add optional `assumeRules`, `withoutRules`,
`checkSuite`, and `recordedSequence`. CLI `what-if` adds repeatable `--assume-rule` and
`--without-rule`, plus `--check-suite <file>` and existing `--as-of-sequence` support.

`CounterfactualApplication` now always includes empty-or-populated rule application lists.
When a rule actually changes, results add `ruleAuditDelta`; when a suite is supplied, they
add `checkDelta`. Existing fact-only fields and behavior are unchanged.

Rule changes remain preview-only. This release adds no rule commit/apply endpoint.
