# Migrating to 0.19

Version 0.19 is additive. Existing `.dl` files, journals, snapshots, rules, CLI commands,
and MCP requests require no migration.

Natural-language recall may perform one additional LLM query-review call when a non-empty
result matches a bounded deterministic ambiguity signal. Ordinary grounded answers and
all raw Datalog operations retain their existing paths.

When review occurs, recall responses add `queryReviews`. New public TypeScript types are
`RecallQueryReview` and `RecallQueryReviewReason`. Consumers that reject unknown response
fields should allow this additive property before upgrading.

The review does not alter stored memory, Datalog semantics, proofs, sources, graph
construction, canonical identity, recorded snapshots, schema widening, or negative-result
honesty. See [the disambiguation contract](RECALL-DISAMBIGUATION.md).
