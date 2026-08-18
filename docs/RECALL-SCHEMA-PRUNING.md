# Deterministic recall schema pruning

Remembero v0.7 keeps natural-language recall useful when a personal knowledge base grows
beyond 100 predicates. Storage, inference, proofs, and sources are not pruned. Only the
schema context shown to the query-writing LLM is bounded.

## The boundary

```text
allowed .dl clauses
        │
        ├─ deterministic local schema selection ─> bounded LLM prompt ─> query
        │                                                        │
        └──────────────── full exact evaluator <─────────────────┘
                                 │
                         full proofs + sources
```

The selected query always runs over every clause in the requested, LLM-allowed
namespaces. `recall-explain` builds its proof and query-scoped graph from that same full
evaluation. Schema ranking cannot change fact authority, result order, or the first
deterministic proof witness.

## First-pass selection

The default first pass gives detailed context to 32 predicates under a 24 KiB schema
budget. Ranking is local, deterministic, and requires no embedding service:

1. exact normalized question-word overlap with predicate names;
2. close spelling matches;
3. question-word matches in stored fact arguments, so a named person or project can find
   the right predicate even when it is not among that predicate's first three facts;
4. smaller rule-body lexical signals;
5. an explicit boost for `_until` predicates on past/former/before questions;
6. byte-stable predicate-key ordering for ties.

Up to three question-relevant sample facts are shown for selected predicates. Samples are
syntax evidence only. Selected derived predicates bring their transitive rule dependencies,
and past-tense selection keeps a base predicate and its `_until` companion together.

The remaining predicates are listed in a compact name/arity catalog while space permits.
Generated positive goals are validated only against predicates that were actually shown;
validator retry messages never enumerate a hidden full schema.

## Honest negative results

A partial schema slice may find an answer, because the accepted query is evaluated over
the full knowledge base. A partial slice may not conclusively claim that a question is
unanswerable or that no fact matches.

When the first pass is empty or returns `unanswerable`, Remembero widens once to detailed
context for the full schema when all predicates fit the 256-predicate and 24 KiB hard
bounds. Only a complete widened pass may finalize a negative result. Otherwise recall
returns:

```json
{
  "status": "schema_budget_exhausted",
  "answer": "Recall reached its schema budget before it could rule out relevant memories."
}
```

This is deliberately different from “I have no memory.” Raising the first-pass limit can
improve the initial attempt, but it never permits an incomplete prompt to masquerade as
complete evidence.

Recall statuses are:

- `answered`: exact evaluation produced at least one row;
- `no_match`: a complete schema pass produced a valid query with no rows;
- `unanswerable`: a complete schema pass found no predicate capable of expressing the
  question;
- `schema_budget_exhausted`: bounded context could not establish either negative claim.

Pruned results include a `pruning` report with the initial selected predicates, final
schema counts, byte size, completeness flags, and every attempt outcome.

## Configuration

The first-pass detail count is configurable from 1 to 256:

```bash
export REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT=48
remembero recall "Who owns Atlas?" --schema-predicate-limit 48
```

MCP `recall` and `recall_explain` accept an optional `schemaPredicateLimit`. Library
callers can set `PipelineDeps.recallSchemaPredicateLimit`, or override one call with
`RecallOptions.schemaPredicateLimit`. The library also exposes
`selectRecallSchema(...)` for inspection and controlled integrations.

The byte limit is intentionally not an environment or CLI knob. Library tests and
specialized integrations may set `RecallOptions.schemaByteLimit`, bounded from 512 bytes
to 48 KiB. The shipped default remains 24 KiB so prompt growth cannot silently track
knowledge-base growth.

## Safety and compatibility

- Namespace allowlists are checked before any ranking or external LLM call.
- Every rendered schema slice still passes the credential/financial-data guard.
- Predicate names, rules, and sample clauses are never cut mid-token or mid-clause.
- Ranking work is capped at 256 question words, 100,000 clauses, and 10,000 predicate
  candidates; over-limit inputs fail before an LLM call.
- Ranking indexes are ephemeral; no vector store, sidecar graph, or second fact authority
  is created.
- `.dl`, journal, history, temporal source, and graph formats are unchanged from v0.6.
- Stores under the first-pass limit retain the ordinary single-pass behavior.

Lexical ranking is intentionally the v0.7 baseline. Embedding-assisted ranking remains a
future option only if the checked-in scale eval demonstrates a meaningful recall gap that
justifies its privacy and reproducibility cost.

Version 0.34 adds one deterministic improvement first: bounded durable source words and
exact phrases contribute local ranking points without entering the model prompt.
`sourceMatchedPredicates` exposes only the selected predicate signatures that received
that signal.

Version 0.19 adds a separate bounded safeguard after a query returns rows. High-confidence
same-anchor predicate competition or omitted named temporal context triggers one review;
ordinary grounded answers remain one-call. This does not change schema selection or the
honest-negative widening rules above. See
[the non-empty recall disambiguation contract](RECALL-DISAMBIGUATION.md).
