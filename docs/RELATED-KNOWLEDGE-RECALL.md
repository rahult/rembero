# Deterministic related knowledge for recall

Rembero 0.52 can attach bounded local discovery evidence when natural-language recall
cannot produce an answer. It helps a caller pivot from an honest `no_match`,
`unanswerable`, or `schema_budget_exhausted` result to nearby stored facts, rules, and
policies without another model call.

## Use

```bash
rembero recall "Where does Zoe work?" --related
rembero recall "What do we know about Atlas?" \
  --related --related-limit 5 --related-kind fact --related-kind rule
rembero recall-explain "Why was this decided?" --related
```

MCP `recall` and `recall_explain` accept `relatedKnowledge`, `relatedLimit`, and
`relatedKinds`. Library callers set `RecallOptions.relatedKnowledge` to `true` or to an
object containing `limit` and `kinds`.

## Authority boundary

Related knowledge is discovery evidence, not an answer and not logical proof. Enabling it
does not change the recall status, generated query, bindings, why-not explanation, or
answer text. An `answered` result remains unchanged and does not carry suggestions.

The fallback reuses deterministic local knowledge search. Its result contains canonical
clauses, fixed integer scores, explicit score reasons, durable provenance, trust labels,
and the existing search/result/clause/predicate/entity graph. No embedding, vector index,
graph sidecar, or learned relevance state participates.

## Same-view guarantee

Recall captures one immutable current or recorded knowledge snapshot. Related search runs
over those exact clauses and sources with the same namespace selection, entity identity
projection, tentative-trust view, and recorded sequence. It never re-reads a newer store
state after query translation.

This matters for historical and reviewed personal knowledge: the suggested clause and its
source evidence are from the same view that produced the primary recall status.

## Model and privacy behavior

The model calls used for question-to-query translation and review are unchanged. Related
search runs only after the final non-answer state and performs no additional model call.
Durable source text is used and returned under the existing local search redaction and
ranking limits; it is never added to a new model prompt.

## Bounds and failures

The default is 20 related results and the hard maximum is 100. Callers may filter to
`fact`, `rule`, and/or `constraint`. Search retains its 100,000-clause, 256-word, source
ranking, namespace, recorded-history, and 16 MiB CLI/MCP output limits.

Invalid filters, out-of-range limits, non-searchable text, or resource overflow fail
explicitly. Rembero never returns an invented summary or silently treats discovery
evidence as a successful recall answer.
