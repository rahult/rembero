# Migrating to 0.6

Version 0.6 is additive. Existing `.dl` memories and v0.5 journals require no
migration. Supersession continues to delete old facts unless valid-time mode is
explicitly enabled.

## Opting into valid-time supersession

Set this for the CLI and MCP server:

```bash
export REMBERO_VALID_TIME_MODE=archive_until
```

Accepted values are exactly `delete` and `archive_until`; unknown values fail
closed. A single CLI remember can override the environment with
`--valid-time-mode`. Library callers can pass a fourth `RememberOptions`
argument to `rememberText`.

When enabled, an updated ground fact is preserved as
`<predicate>_until(..., '<ISO instant>').` in the same `.dl` file. Existing code
that enumerates predicates should therefore tolerate the new, ordinary
predicate names and their extra timestamp argument.

## Additive API fields and surfaces

- `RememberResult.archived?: string[]`
- `MemoryStore.supersede(...)`
- `MemoryStore.history(...)`
- `MemorySource.temporal?`
- CLI command `remembero history <pattern>`
- MCP tool `history`

The MCP server reports version `0.6.0`.

`MemorySource.temporal`, new history event fields, and the new result property
are additive. Exhaustive TypeScript handling of source objects may need to
accept them. Existing query, proof, and graph node unions do not change.

## Journal compatibility

New plain retract events include `removedClauses`. Valid-time updates write one
exact `supersede` event. History understands both the old pattern/count form and
the new exact forms. Append order is authoritative even when timestamps are
equal or library callers inject controlled clocks for testing.

See [the temporal history contract](TEMPORAL-HISTORY.md) for limits, redaction,
and the boundaries that keep auto-capture and explicit forgetting unchanged.
