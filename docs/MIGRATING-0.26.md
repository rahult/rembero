# Migrating to 0.26

Version 0.26 is additive. Existing namespace files, journals, checkpoint segments,
recorded snapshots, topology, query graphs, trust state, and recall behavior require no
migration.

New interfaces are:

- store: `MemoryStore.recordedSnapshots(...)` and `MAX_RECORDED_SNAPSHOT_BATCH`;
- library: `diffRecordedKnowledge(...)`, recorded-diff result/delta types, and
  `MAX_RECORDED_DIFF_CHANGES`;
- CLI: `diff <from-sequence> <to-sequence>` and optional `--query <datalog>`; and
- MCP: `diff_recorded_knowledge`.

Diff output is a new object and does not alter the existing single-snapshot response
shape. It can contain complete before/after integrity and query explanations, so clients
should retain the existing 16 MiB response handling and may omit `query` when only direct,
topology, and policy changes are needed.

`RecordedClauseKind` includes `identity_metadata`. Tentative declarations remain hidden
in default trust and appear as projected facts only under `include_tentative`; the diff
does not expose their reserved encoded representation.
