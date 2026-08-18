# Recorded-time snapshots

Remembero 0.14 can reconstruct the knowledge base exactly as it stood after a durable
journal entry. This is a read-only, deterministic view over the same portable Datalog
store; it is not a second database or an approximate retrieval index.

## Authoritative axis

The snapshot coordinate is the global append position in the logical journal:

- sequence `0` is the empty state before the first journal entry;
- sequence `n` includes mutations through journal line `n`;
- non-mutation audit entries still consume a position, so the coordinate never changes;
- timestamps do not order snapshots. They remain descriptive valid-time metadata and may
  be caller supplied.

Since version 0.22, that logical journal may span ordered immutable segments plus the
active `journal.log` tail. Rotation never renumbers an entry. Missing, reordered, or
content-tampered segments fail closed before a snapshot is returned.

Use `history <pattern> --json` to discover relevant journal sequences, then pass
`--as-of-sequence <n>` to `recall`, `recall-explain`, `query`, `explain`, `check`, or
`list`. The library uses `recordedSequence`; MCP exposes the same field.

```bash
rembero history 'status(mira, _)' --json
rembero query 'status(mira, State)' --as-of-sequence 17
rembero explain 'colleague(mira, Who)' --as-of-sequence 17
rembero diff 17 23 --query 'colleague(mira, Who)'
```

Historical results include `recordedSnapshot` metadata with the selected sequence,
current journal length, and namespaces. Ordinary current reads retain their existing
response shape.

Version 0.26 can compare two positions directly. The diff includes semantic clauses,
sources, topology, integrity, and optional query-proof consequences; both endpoints are
captured under one journal boundary.

## Completeness and failure behavior

Before returning any past view, Remembero replays the complete selected journal and compares
its final clause set with the current namespace files. A hand edit, legacy writer, missing
journal record, corrupt/unknown in-scope operation, or out-of-range sequence fails closed with
`IncompleteHistoryError` (`incomplete_recorded_history` over MCP and CLI exit `5`). Remembero never presents
an incomplete replay as authoritative history.

Rules, constraints, identity declarations, source provenance, valid-time archives, and
graph explanations all use the selected snapshot. Writes and integrity enforcement always
operate on the current state and never accept a historical sequence.

Version 0.21 includes tentative declarations and their accept/reject transitions in the
same replay. The default view excludes a claim at its tentative sequence; an explicit
`include_tentative` view returns it with trust provenance. Later acceptance cannot rewrite
that earlier result.

## Temporal boundary

Recorded-time snapshots and `_until` archives are distinct axes:

- journal sequence answers what the local store recorded by an operation boundary;
- `_until` facts describe when a superseded fact stopped being valid.

Together they support useful personal knowledge history without claiming full bitemporal
interval algebra. There is no timestamp-based snapshot selector because timestamps are
not authoritative transaction time.
