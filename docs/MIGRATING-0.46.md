# Migrating to 0.46

Version 0.46 is additive. Existing direct `remember`, proposals, tentative claims, rules,
journals, checkpoints, and stored files require no manual migration.

New interfaces are:

- library `parseMemoryProposal(...)` and `applyMemoryProposal(...)`;
- CLI `apply-memory <file> --op-id <id>`; and
- MCP `apply_memory_proposal`.

The journal gains a replayable `memory_change` operation for reviewed mixed clause
changes. Rembero handles it automatically in sources, fact history, temporal lineage,
recorded snapshots/diffs, bundles, checkpoints, and idempotent replay.

Application always enforces proposal and baseline digests, candidate rule audit, and
no-new-integrity-violations policy.
