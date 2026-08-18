# Immutable journal checkpoints

Remembero 0.22 can rotate a full or administratively chosen active journal without
discarding its recorded-time history. The checkpoint is an audit boundary, not a new
knowledge authority: portable `.dl` files remain current state and the complete logical
journal remains the source for recorded snapshots.

Version 0.33 bundles provide a separate portable artifact for raw clauses and provenance.
Checkpoint files remain internal crash/audit boundaries and are not an interchange format.

## Use

```bash
rembero checkpoint --dry-run --op-id checkpoint-2026-08-17
rembero checkpoint --op-id checkpoint-2026-08-17
rembero checkpoints
```

The library exposes `MemoryStore.compactJournal(...)` and
`MemoryStore.listJournalCheckpoints()`. MCP exposes `checkpoint_journal` and
`list_checkpoints`. A caller-supplied operation ID makes rotation retry-safe. An optional
canonical UTC `at` value labels the artifact but never controls recorded ordering.

## On-disk contract

The active tail remains `journal.log`. Rotation renames it into
`.journal-segments/journal-<start>-<end>-<sha256>.jsonl`, then atomically publishes
`.journal-checkpoints/checkpoint-<end>-<segment-sha256>.json`.

Each checkpoint contains:

- the immutable segment identity, byte count, entry count, and sequence range;
- the exact canonical clauses and durable sources in every namespace at that boundary;
- a SHA-256 digest of that state; and
- the checkpoint operation ID and descriptive creation instant.

Readers concatenate the strictly contiguous segment chain with the active tail. Sequence
zero and every historical sequence therefore retain their pre-rotation meaning.

## Failure and recovery

Remembero rejects symbolic links, non-files, unexpected artifacts, invalid ranges,
non-contiguous segment chains, content/name digest mismatches, malformed checkpoints, and
checkpoint state that differs from deterministic replay. It never silently skips a bad
artifact.

Rotation holds the same cross-process mutation and journal locks as store writes. The
segment rename happens before checkpoint publication, so an interruption cannot make old
history disappear. A later non-dry-run checkpoint repairs a segment whose checkpoint was
not published. Dry-run computes the proposed result without creating, repairing, moving,
or deleting any artifact.

## Bounds

Each active journal and immutable segment retains the existing 16 MiB and 100,000-entry
limits. A store accepts at most 64 immutable segments, one million logical journal
entries, and 32 MiB per checkpoint. These are fail-closed local resource boundaries, not
retention policies: version 0.22 never truncates or deletes recorded history.
