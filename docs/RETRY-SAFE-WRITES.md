# Retry-safe raw writes

Rembero 0.13 gives raw assertions and retractions an explicit at-most-once effect under
caller retries. The portable `.dl` file remains authoritative, while the existing
append-only journal records the operation result needed for deterministic replay.

## Contract

The idempotency key is `(namespace, operation, opId)`. Operation IDs are non-empty and
limited to 256 UTF-8 bytes.

- The first explicit operation runs under the global mutation lock, namespace lock, and
  journal lock, then commits through the existing crash-recoverable mutation protocol.
- A retry with the same normalized request returns the first durable result. Assertion
  replays preserve the original `added` clauses and duplicate count; retraction replays
  preserve the original removed count.
- Reusing the same key for a different normalized request throws
  `OperationConflictError` with code `operation_conflict`. It never applies the second
  request.
- Explicit no-op operations write one journal-only replay marker. Their retries do not
  grow the journal. Implicit operations keep the prior behavior and do not journal a
  no-op.
- Keys are scoped by operation and namespace. They are not credentials, authorization
  boundaries, or global transaction IDs.

Clause whitespace and alpha-equivalent variable names are normalized before comparison.
Retraction literals, exact rules, and integrity constraints use the same structural
identity, so `f(X)` and `f(Value)` are the same retry target.

## Interfaces

Library callers pass `MutationContext.opId` to `MemoryStore.assert`, `retract`,
`replace`, or `supersede`. `OperationConflictError`, `MAX_OPERATION_ID_BYTES`, and the
operation type are public exports.

```ts
const first = store.assert('personal', 'prefers_theme(rahul, dark).', {
  opId: 'preference-2026-08-17',
});
const replay = store.assert('personal', 'prefers_theme(rahul, dark).', {
  opId: 'preference-2026-08-17',
});
```

CLI `assert`, `forget`, and `import` accept `--op-id`. A conflicting reuse writes a JSON
error to stderr and exits `4`.

MCP `assert_facts` and `forget` accept `opId`. Conflicts return `isError: true` with a
JSON `operation_conflict` payload.

Natural-language `remember` and ambient capture keep their existing extraction and
reservation contracts; v0.13 does not treat a nondeterministic LLM request as a raw
mutation request.

Legacy journal entries remain readable. A pre-0.13 assertion can be replayed only when
its durable fields prove the original request (all requested clauses were newly added);
ambiguous legacy duplicate cases fail closed rather than guessing.
