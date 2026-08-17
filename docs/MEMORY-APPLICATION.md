# Digest-bound reviewed personal memory application

Rembero 0.46 completes the proposal-first accepted-memory workflow. `propose-memory`
remains non-mutating; a separate explicit apply operation accepts the reviewed artifact,
revalidates it under the global mutation lock, and commits all exact facts, rules,
removals, and temporal archives as one crash-safe change or writes nothing.

## Workflow

```bash
rembero propose-memory 'Mira now works at Initech.' \
  --valid-time-mode archive_until --at '2026-08-17T08:30:00.000Z' \
  > memory-review.json

rembero apply-memory memory-review.json --op-id mira-employment-v2
```

The file may be a standalone `proposal` object or the complete `propose-memory` output.
The library exposes `parseMemoryProposal(...)` and `applyMemoryProposal(...)`. MCP exposes
`apply_memory_proposal`.

This is accepted-memory mutation authority. Calling it requires deliberate selection of
the reviewed artifact and a stable operation ID; proposal existence alone is not approval.

## In-lock validation

Application owns the global mutation, target namespace, and journal locks while it:

1. validates every proposal field and its content SHA-256;
2. resolves a matching idempotent replay or rejects operation-ID reuse;
3. recomputes the exact ordered governed-program digest and rejects stale evidence;
4. requires every reviewed removal to remain present and every addition to remain absent;
5. reconstructs and validates any exact `_until` archive lineage;
6. builds and fully audits the candidate facts/rules;
7. re-runs any proposal-bound knowledge checks and semantic coverage requirement;
8. enforces mandatory `no_new_violations` across exactly the governed namespaces; and
9. commits one namespace replacement and one `memory_change` journal event using the
   existing crash-recovery marker protocol.

Any stale, tampered, parse, stratification, resource, integrity, or output failure occurs
before the namespace or journal changes.

## Durable replay and evidence

The journal event records exact added/removed clauses, temporal mappings, namespaces,
baseline/proposal digests, source text, and operation ID. It replays through:

- current source lookup and source-aware proofs;
- fact history, including `retracted` and `superseded` transitions;
- `_until` temporal source metadata;
- exact recorded snapshots and semantic diffs;
- bundles and immutable journal checkpoints; and
- idempotent retries at the original global sequence.

Mixed fact and rule extraction remains one atomic operation. A failure cannot leave the
fact committed without its reviewed rule, or remove an old fact without its replacement.

## Concurrency and errors

Competing processes with proposals from the same baseline serialize under the mutation
lock. The winner commits; every later proposal sees a changed digest and returns
`memory_change_stale`. Reusing an operation ID with other content returns
`operation_conflict`.

The CLI uses exit `7` for stale proposals, `3` for integrity rejection, and `4` for
operation conflicts. MCP returns the same structured error codes.

Version 0.49 adds `memory_change_checks_failed` with CLI exit `2`; no mutation occurs.

Tentative uncertainty retains its separate `claims`/`accept`/`reject` authority flow.
Memory proposals are reviewed transitions into accepted knowledge and cannot author
integrity policy or reserved identity/trust metadata.
