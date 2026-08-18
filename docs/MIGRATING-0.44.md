# Migrating to 0.44

Version 0.44 is additive. Existing rules, counterfactual previews, journals, checkpoints,
recorded snapshots, and stored formats require no manual migration.

New interfaces are:

- `ruleProposal` on effective v0.43 rule-change previews;
- library `parseRuleChangeProposal(...)` and `applyRuleChangeProposal(...)`;
- CLI `apply-rule-change <file> --op-id <id>`; and
- MCP `apply_rule_change`.

The journal gains a replayable `rule_change` operation. Remembero handles it automatically
in current sources, recorded snapshots/diffs, checkpoint rotation, and idempotent replay.

Application always enforces the proposal digest, current baseline digest, candidate rule
audit, attached suite/coverage, and no-new-integrity-violations policy. Recorded-baseline
proposals are intentionally non-applicable.
