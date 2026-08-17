# Migrating to 0.21

Version 0.21 is additive. Existing `.dl` files, accepted facts, rules, constraints,
journals, snapshots, queries, and default recall behavior require no migration.

Tentative facts use the explicit reserved declaration documented in
[reviewable knowledge trust](TRUSTED-KNOWLEDGE.md). They are excluded from every ordinary
read unless `trustMode: "include_tentative"` or CLI `--trust include_tentative` is
requested.

New library surfaces include:

- `MemoryStore.assertTentative(...)` and `MemoryStore.resolveTentative(...)`;
- `wrapTentativeFacts`, `reviewTentativeClaims`, `assertTentativeFacts`, and
  `resolveTentativeFacts`;
- `KnowledgeTrust`, `TrustViewMode`, `TentativeClaim`, and related result types.

CLI adds `--trust tentative` for `remember`/`assert`, `--trust include_tentative` for
reads, plus `claims`, `accept`, and `reject`. MCP adds `assert_tentative`,
`review_tentative`, and `resolve_tentative` and trust fields on primary read/remember
tools.

Opt-in read results may add `trustMode`, proof and graph claims may add `trust`, and
recall adds per-row `rowTrust`. Accepted facts created by promotion may expose
`trustAction: "accept"` in source/history metadata. Consumers that reject unknown response
fields should allow these additive properties before upgrading.

Raw `assert_facts` no longer accepts `rembero_tentative` declarations; use the typed
tentative surface so embedded facts are bounded and validated.
The core `MemoryStore.assert`, `retract`, `replace`, and `supersede` methods likewise
reserve trust metadata. Portable imports containing validated tentative declarations use
`MemoryStore.importClauses`.
