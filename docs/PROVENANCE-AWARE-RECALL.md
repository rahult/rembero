# Provenance-aware recall schema ranking

Rembero 0.34 uses the user's own durable source vocabulary to improve local recall schema
selection. This addresses cases where a canonical predicate is intentionally technical or
generic but the source statement contains the language used in a later question.

For example, `fact_z(atlas, rust).` may have source text “What technology stack does Atlas
use?” Source-aware ranking can select `fact_z/2` over a superficially stronger
`atlas_owner/2` match under a one-predicate detail budget.

## Scoring

Source evidence composes with the existing deterministic schema rank:

- 40 points for each distinct normalized question word present in bounded source text;
- 120 points when the complete lowercased question is an exact source substring; and
- at most 4,096 source characters are inspected per predicate group.

Each predicate group aggregates sources attached to its facts and rules in deterministic
clause/source order. Existing head-predicate, fuzzy-predicate, fact-term, rule-dependency,
and temporal-intent scores are unchanged. Dependency and temporal companion closure still
decide which complete group can fit the predicate budget.

## Privacy boundary

Source text is ranking input only. It is never copied into the schema summary, predicate
catalog, sample facts, query-review evidence, or answer-phrasing prompt. Model messages
remain limited to the already documented question, selected rules, predicate signatures,
and escaped syntax samples.

Normal source ingestion has already redacted credential-like text. The ranking path does
not weaken the question/schema external-LLM safety checks.

## Diagnostics and views

`RecallSchemaSelection`, `RecallSchemaDiagnostics`, and pruning reports add
`sourceMatchedPredicates`: selected `name/arity` signatures whose score received a local
source signal. The field never contains source words or text and is empty when no source
matched.

Current recall passes the coherent projected source map into every initial, maximum-budget,
and widening selection. Canonical identity and `include_tentative` therefore rank only the
same visible view that will be evaluated. Recorded recall uses provenance from that exact
journal sequence.

## Scope and bounds

Provenance ranking improves selection; it does not change the accepted query, complete
knowledge evaluation, proof, graph, result status, or answer. A source match is relevance
evidence, not confidence or truth probability.

Existing 256 question-word, 10,000 predicate-candidate, 100,000 clause, 48 KiB prompt,
namespace, and output limits remain. Source characters after the per-predicate bound do
not contribute and are never silently added to the prompt.
