# Temporal history

Rembero 0.6 can preserve the fact that was current immediately before a manual
natural-language update. The feature is opt-in: deletion remains the default.

```bash
export REMBERO_VALID_TIME_MODE=archive_until
rembero remember "Mira now works at Initech"
```

The same mode can be selected for one CLI call with
`--valid-time-mode archive_until`. Library callers pass
`{ validTimeMode: 'archive_until' }` to `rememberText`. MCP servers read the
environment variable when they start.

## Stored representation

If the validated extraction is:

```prolog
retract works_at(mira, _).
works_at(mira, initech).
```

and `works_at(mira, acme).` is current, one store mutation produces:

```prolog
works_at(mira, initech).
works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').
```

The final `_until` argument is the canonical UTC instant at which the preceding
fact stopped being current. These archives are ordinary ground Datalog facts in
the same namespace and portable `.dl` file. They can be queried and explained by
the existing deterministic engine; the journal does not become a second fact
database.

The store writes one exact `supersede` journal event for the whole transition. It
records the matched facts, their previous source operation IDs when known, the
archive mapping, and the replacement facts. Replaying the same operation ID with
the same parameters is idempotent. Reusing it for different parameters fails.

## Inspecting a life story

History is local and LLM-free:

```bash
rembero history 'works_at(mira, _)' --json
rembero history 'works_at(mira, _)' --namespaces personal,work
```

The MCP tool is also named `history`. The library API is:

```ts
store.history('works_at(mira, _)', {
  namespaces: ['personal'],
  limit: 100,
});
```

Events contain the one-based journal line (`sequence`) and the stable position
inside that operation. Their order is journal append order. Timestamps are
descriptive valid-time metadata and never reorder concurrent or equal-time
events. An event is marked `current` only when that exact assertion is still the
live source of the clause in the `.dl` file.

History accepts exactly one positive literal with constants, variables, or
wildcards. Comparisons, negation, aggregates, multi-goal queries, and rule
patterns are rejected. The journal is capped at 16 MiB and 100,000 entries;
history returns at most 1,000 matching events and fails rather than silently
truncate when the requested bound is exceeded. Source statements are redacted
again on read and individually bounded to 4 KiB. Raw auto-capture transcripts,
session IDs, and hook payloads are never included.

Older assert/retract journals remain readable. Rembero replays the exact clauses
available in their prior assertions; new retract entries additionally record the
exact clauses removed. A corrupt line, timestamp, clause, archive mapping, or
count fails the history read closed.

## Temporal recall and proofs

The recall query prompt understands the `_until` convention. Present-tense
questions use the base predicate; explicit past, former, previous, or "before"
questions use the archived predicate shown in the schema.

```bash
rembero recall-explain "Where did Mira work before Initech?"
rembero explain "works_at_until(mira, Company, Until)"
```

Sources attached to an archived fact include additive temporal metadata:

```json
{
  "temporal": {
    "kind": "superseded",
    "previousClause": "works_at(mira, acme).",
    "validUntil": "2026-08-16T16:59:00.000Z"
  }
}
```

## Authority boundaries

- Valid-time archiving applies only to validated manual `remember`
  supersessions.
- `forget` remains destructive because explicit removal is not supersession.
- Auto-capture remains additive-only and cannot silently close facts.
- Raw `assert_facts` remains literal: callers explicitly choose every clause.
- `_until` predicates are system-managed in extraction prompts.
- This is valid-time supersession, not a full bi-temporal interval model.
- The experimental SQLite extension does not add a separate temporal API in
  this release; ordinary archive-shaped table rows can still be modeled by the
  application.
- Explicit entity-position declarations extend to the corresponding `_until` predicate
  during canonical query, recall, proof, and integrity projection. `history` itself stays
  literal and never rewrites the durable event stream.
