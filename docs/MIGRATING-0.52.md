# Migrating to 0.52

Version 0.52 is additive. Recall behavior is unchanged unless related knowledge is
explicitly requested.

Library callers can set `RecallOptions.relatedKnowledge`; MCP adds `relatedKnowledge`,
`relatedLimit`, and `relatedKinds`; CLI adds `--related`, `--related-limit`, and repeatable
`--related-kind`.

Only final `no_match`, `unanswerable`, and `schema_budget_exhausted` results receive a
`relatedKnowledge` field. It is deterministic discovery evidence and never changes the
primary recall status or answer. No stored format changes are required.
