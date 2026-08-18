# Explicit temporal corrections

Remembero 0.16 lets local applications and agents correct current knowledge while
preserving what immediately preceded it, without asking an LLM to translate the change.
The portable `.dl` file remains the only fact authority.

## CLI

```bash
rembero supersede 'works_at(mira, initech). title(mira, lead).' \
  --namespace personal \
  --pattern 'works_at(mira, _)' \
  --pattern 'title(mira, _)' \
  --at '2026-08-16T16:59:00.000Z' \
  --op-id employment-correction-42
```

Each `--pattern` is one positive fact literal. The command accepts 1–64 patterns. Optional
positional Datalog text contains zero or more replacement clauses, so a relationship may
also be ended without inventing a new current value. The output reports exact added,
archived, retracted, and duplicate counts plus the durable operation ID.

`--at` is optional. When supplied it must be the exact canonical UTC form emitted by
`Date.toISOString()`, including milliseconds and `Z`. It describes when the matched facts
stopped being current; it never overrides authoritative journal append order.

## MCP

The `supersede_facts` tool accepts the same contract:

```json
{
  "patterns": ["works_at(mira, _)", "title(mira, _)"],
  "replacements": "works_at(mira, initech). title(mira, lead).",
  "namespace": "personal",
  "at": "2026-08-16T16:59:00.000Z",
  "opId": "employment-correction-42"
}
```

`replacements` may be omitted for an end-only correction. The tool also accepts the same optional integrity mode, governed namespaces, proof bound,
violation bound, entity projection, and graph selector as other guarded raw writes.

## Atomic result

For every matched current ground fact, Remembero validates and adds a corresponding
`<predicate>_until(..., '<instant>').` fact, removes the current fact, and adds the
optional replacement clauses in one crash-recoverable mutation. If validation, integrity
enforcement, journal capacity, or commit preparation fails, none of those changes become
visible.

Patterns do not match rules or archived predicates unless named explicitly. Overlapping
patterns close each fact once. Replacement clauses retain ordinary Datalog validation and
deduplication behavior. `forget` remains destructive and is still the correct operation
when history should not represent a replacement.

## Retry and authority contract

An explicit `opId` makes the full correction retry-safe across processes. The normalized
patterns, requested replacement clauses, archive mode, and any caller-supplied instant
must match the first request. A differing request raises `OperationConflictError`; it
never applies a second mutation. Supplying `at` on only one of the two calls is also a
conflict. When `at` is omitted from both calls, a retry replays the first durable result
instead of comparing a new wall-clock value.

An explicit no-op correction records one journal-only replay marker. If matching facts
arrive later, retrying that operation ID still returns the original zero-effect result
instead of closing the new facts. Calls without an explicit operation ID keep no no-op
marker.

Journal entries written before 0.16 do not record whether their timestamp was explicit.
An operation-ID replay of such an entry therefore fails closed when `at` is omitted.
Supplying the exact durable journal timestamp permits a verifiable replay; a different
instant conflicts.

The journal records exact ended clauses, prior source operation IDs, archive mappings,
replacement requests, actual additions, and the descriptive instant. `history`, recorded
snapshots, past-tense recall, explanations, and query-scoped graphs consume that same
lineage. No temporal sidecar or graph database is introduced.

## Bounds and trust

- Replacement text and the combined interface patterns are each bounded to 64 KiB.
- At most 64 patterns are accepted; store, journal, proof, graph, and integrity limits
  continue to apply.
- Raw callers author policy-capable Datalog, so this interface belongs behind the same
  local trust boundary as `assert_facts` and `forget`.
- Valid-time archives describe a preceding fact's end. They do not infer start times or
  constitute full interval algebra.
