# Migrating to 0.14

Version 0.14 is additive. Current reads, writes, storage files, and default response shapes
are unchanged.

New APIs:

- `MemoryStore.recordedSnapshot(namespaces, sequence)` reconstructs clauses and sources;
- read tools and `RecallOptions` accept `recordedSequence`;
- CLI read commands accept `--as-of-sequence`;
- MCP read tools accept `recordedSequence`;
- historical responses include `recordedSnapshot` metadata;
- `IncompleteHistoryError` reports selected namespaces whose current files cannot be
  reconciled with the journal.

Applications that edited `.dl` files directly before 0.14 may continue using current
reads, but historical reads fail closed until the store has a complete journal-backed
lineage. Do not infer a sequence from timestamps; use the `sequence` values returned by
`history`.
