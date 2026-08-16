# Migrating to Rembero 0.7

Version 0.7 adds deterministic, bounded schema selection to natural-language recall. No
memory or journal migration is required.

The MCP server reports version `0.7.0`.

## Additive response fields

`retrieveQuestion`, `recallQuestion`, MCP `recall`, and MCP `recall_explain` now return a
required `status`:

- `answered`
- `no_match`
- `unanswerable`
- `schema_budget_exhausted`

Callers that previously inferred “no memory” from only `query === null` should inspect
`status`. `schema_budget_exhausted` means bounded schema context could not prove a
negative result; it must not be presented as “nothing is remembered.”

When pruning activates, the response also has an additive `pruning` report. Existing
consumers that ignore unknown JSON fields remain compatible.

## Optional tuning

The default first-pass detailed slice is 32 predicates. To change it:

```bash
export REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT=48
```

The accepted range is 1–256. The equivalent CLI option is
`--schema-predicate-limit`; MCP uses `schemaPredicateLimit`. Programmatic callers can set
`PipelineDeps.recallSchemaPredicateLimit` or `RecallOptions.schemaPredicateLimit`.

This limit controls the first attempt. If it is inconclusive, Rembero may widen once
within the fixed predicate and byte safety bounds before returning a negative status.

## Unchanged contracts

- Raw `query`, `explain`, `history`, `remember`, and auto-capture behavior is unchanged.
- Accepted generated queries still evaluate against the complete selected namespace set.
- Proof, provenance, temporal, graph, `.dl`, and journal formats are unchanged.
- LLM namespace allowlists and sensitive-text rejection still run before external export.

See [the full pruning contract](RECALL-SCHEMA-PRUNING.md) for ranking, widening, and
fail-closed behavior.
