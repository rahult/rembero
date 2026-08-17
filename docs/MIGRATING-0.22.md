# Migrating to 0.22

Version 0.22 is additive. Existing `.dl` files and `journal.log` files require no data
migration. Until `checkpoint` is invoked, their on-disk layout and behavior are unchanged.

The first successful checkpoint creates private `.journal-segments` and
`.journal-checkpoints` directories below the memory root. Backups must include these
directories together with `journal.log` and the namespace files. Restoring only the active
tail after rotation is incomplete and recorded-time reads will fail closed.

New interfaces are:

- library: `MemoryStore.compactJournal(...)`,
  `MemoryStore.listJournalCheckpoints()`, and the exported checkpoint result/types;
- CLI: `checkpoint`, `checkpoints`, and checkpoint-only `--dry-run`;
- MCP: `checkpoint_journal` and `list_checkpoints`.

Checkpoint operation IDs are retry-safe. Reusing an ID with a different explicit
timestamp returns the existing `operation_conflict` shape. Existing recorded sequence
numbers, history results, current reads, rules, trust state, provenance, graphs, and
integrity behavior do not change across rotation.
