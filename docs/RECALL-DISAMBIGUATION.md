# Non-empty recall disambiguation

Version 0.19 closes a dangerous gap between deterministic query execution and
natural-language query choice. Before 0.19, the first structurally valid query that
returned rows was accepted immediately. A related but semantically wrong predicate could
therefore produce a confident answer backed by real—but irrelevant—facts.

Rembero now reviews a non-empty query once when deterministic local evidence identifies
one of two bounded ambiguity classes:

- **same-anchor predicate competition**: the chosen predicate has no direct word overlap
  with the question, while another visible predicate with the same arity has facts at the
  same ground argument positions and either ranks ahead locally or has stronger predicate
  word overlap;
- **missing temporal context**: a `before` or `prior to` question uses a historical
  `_until` predicate, omits its visible base predicate, and the question names a current
  state present in that same anchored base relation.

The detector uses the validated, canonicalized query and the exact current or recorded
snapshot being evaluated. It does not inspect raw model text, infer new facts, or change
Datalog results.

## Review contract

The review receives only:

- the original question and executed query;
- at most three returned binding rows;
- stable reason codes;
- at most four competing predicate name/arity keys;
- the same bounded schema prompt used for query generation.

The evidence payload passes the external-LLM secret and byte checks before transmission.
The model may repeat the query, emit one corrected query, or declare the question
structurally unanswerable. Every emitted query passes the existing parser, visible-predicate,
negation, aggregate-intent, canonical-identity, and engine safety checks.

There is no recursive review loop. Each schema pass can trigger at most one review. A
reviewed query that returns no rows remains honest negative evidence; it is not forced
back toward a non-empty answer.

## Observable result

When a review occurs, `retrieveQuestion`, `recallQuestion`, CLI recall JSON, and MCP recall
responses add a `queryReviews` array. Each entry records:

- `originalQuery` and nullable `reviewedQuery`;
- stable `reasons`: `competing_predicate` or `missing_temporal_context`;
- bounded `competingPredicates`;
- `outcome`: `repeated`, `corrected`, or `unanswerable`.

Multiple entries are possible only when bounded schema widening causes another complete
query-generation pass. Review-returned `unanswerable` never bypasses widening: a partial
schema still widens or returns `schema_budget_exhausted` under the existing honest-negative
contract.

## Deliberate boundary

This is a high-confidence ambiguity detector, not a general semantic oracle. It does not
review every non-empty answer, expose private ranking scores, use graph output as model
context, or claim that a reviewed query is formally equivalent to the English question.
Exact facts, rules, proofs, sources, and graph evidence remain authoritative only after
the reviewed query is deterministically evaluated.
