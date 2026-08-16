# Migrating to 0.16

Version 0.16 is additive. Existing `.dl` files, journals, reads, and natural-language
supersession behavior need no migration.

New interfaces:

- CLI `supersede <replacement-clauses> --pattern <fact-pattern>`; repeat `--pattern` up
  to 64 times and optionally pass `--at`, `--op-id`, namespace, or integrity options.
- MCP `supersede_facts` with `patterns`, optional `replacements`, optional canonical UTC `at`, and
  the existing retry and integrity fields.
- Public `MAX_SUPERSEDE_PATTERNS` reports the shared pattern limit.

The direct interfaces always preserve matched facts as `_until` archives. Use `forget`
for destructive removal or `assert_facts` for additive writes.

One retry detail is stricter: when a caller explicitly supplies a supersession timestamp,
that instant is now part of operation-conflict validation. Reusing an existing operation
ID with a different explicit instant fails instead of replaying the earlier timestamp.

Pre-0.16 supersede journal entries do not identify whether their timestamp came from the
caller. Retrying one of those operation IDs without `at` now fails closed. Pass the exact
`ts` stored on the original journal entry to replay it safely.
