# Migrating to Remembero 0.13

Version 0.13 adds optional idempotency keys for raw writes. Existing `.dl` files,
journals, history, generated operation IDs, natural-language memory, MCP clients, and
SQLite behavior need no migration.

To make a retryable raw write, generate one stable operation ID before the first attempt
and reuse it only for that logical request:

```bash
remembero assert 'decision(project, sqlite).' --op-id decision-123
remembero forget 'decision(project, _)' --op-id decision-remove-123
remembero import personal memories.dl --op-id import-2026-08-17
```

Matching retries return the original result. Do not generate a new ID for transport
retries, and do not reuse an ID for a different request. Conflicting reuse fails with
`operation_conflict`; the CLI exits `4`.

Explicit no-op writes now create one journal replay marker so a later retry cannot be
mistaken for a new request. No-op writes without a supplied ID remain unjournaled.
