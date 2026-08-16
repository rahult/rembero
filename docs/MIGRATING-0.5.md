# Migrating to 0.5

Version 0.5 is additive. Existing `.dl` memories, rules, queries, MCP clients, and
`journal.log` entries remain valid.

## New opt-in commands

- `rembero init-hooks` installs one managed asynchronous Claude Code Stop hook.
- `rembero remember --batch` accepts a Stop-hook JSON payload on stdin. It is intended
  for the managed hook and is silent unless `--json` is supplied.
- `rembero review` shows recent auto-capture attempts and facts.
- `rembero review --forget <number,...>` explicitly prunes selected facts.
- `rembero init-hooks --remove` and `rembero remove-hooks` remove the managed hook.

Nothing is installed automatically during package installation or upgrade. Existing
users must run `init-hooks` to opt in.

## Store and library additions

`MemoryStore` now serializes cross-process writers with local lock files and caps journal
growth before mutation. It exposes journal-backed auto-capture reservation, review, and
pruning methods. The package root also exports the transcript reader, hook installer, and
`autoCaptureClaudeStop` orchestration function.

`MutationContext` accepts optional `origin`, `captureId`, and `at` fields. Existing callers
need no changes.

Auto-captured facts use a neutral source label rather than the raw transcript. This keeps
proofs readable and avoids turning an entire session tail into per-fact provenance.

See [the auto-capture contract](AUTO-CAPTURE.md) for security boundaries, quotas, and the
review workflow.
