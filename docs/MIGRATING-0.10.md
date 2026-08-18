# Migrating to Remembero 0.10

Version 0.10 adds opt-in atomic integrity enforcement. Existing `.dl` files, 0.9
constraints, journal entries, queries, proofs, recall results, and graphs require no data
migration. Enforcement is off unless a caller, CLI invocation, or server configuration
enables it.

## Recommended rollout

1. Upgrade every process that writes the same `REMBERO_HOME`. Version 0.10 writers share
   the new global mutation lock; older writers do not.
2. Run `rembero check --namespaces '*'` and retain the evidence for each finding.
3. If findings exist, start with `REMBERO_INTEGRITY_MODE=no_new_violations`. This permits
   unrelated writes and repairs but rejects a new violation identity.
4. Repair the remaining rows explicitly.
5. Switch to `REMBERO_INTEGRITY_MODE=strict` once the audit is clean.

For a policy namespace plus personal facts, set the complete governed view:

```bash
export REMBERO_INTEGRITY_MODE=strict
export REMBERO_INTEGRITY_NAMESPACES=policy,personal
```

The target namespace of every write must appear in that list. Use `*` when all local
namespaces form one knowledge view.

## Additive API changes

- `MutationContext.integrity?: IntegrityEnforcementOptions`
- `PipelineDeps.integrityEnforcement?: IntegrityEnforcementOptions | false`
- `RememberOptions.integrityEnforcement?: IntegrityEnforcementOptions | false`
- `MemoryStore.replace(...)` for atomic delete-and-replace plans
- `IntegrityViolationError` with `toJSON()` evidence
- MCP write fields: `integrityMode`, `integrityNamespaces`, `proofLimit`, and
  `maxViolations`
- CLI flags: `--integrity-mode` and `--integrity-namespaces`
- CLI exit `3` means an enforced write was rejected

Delete-style natural-language updates are now journaled as one `supersede` operation
with `validTimeMode: "delete"` rather than separate retract/assert operations. History
still reports the same fact life story, but now the transition is atomic and carries one
operation ID. Legacy supersede entries without `validTimeMode` continue to replay as
`archive_until`.

See [INTEGRITY-ENFORCEMENT.md](INTEGRITY-ENFORCEMENT.md) for exact modes, evidence,
concurrency, namespace, auto-capture, and manual-edit boundaries.
