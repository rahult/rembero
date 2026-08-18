# Deterministic why-not explanations

Remembero 0.24 explains why a bounded Datalog query has no result. This is engine evidence,
not an LLM-generated story: diagnostics materialize the same finite fixpoint, preserve
authored goal order, and follow each eliminated binding through the rules that could have
derived the requested predicate.

## Use

```bash
rembero why-not 'colleague(mira, rahul)'
rembero why-not 'eligible(bob)' --proof-limit 2
rembero why-not 'status(mira, active)' --as-of-sequence 17
```

The library exposes `explainWhyNot(clauses, query, sources, options)`. MCP exposes
`why_not`. Natural-language `recall-explain` adds `whyNot` automatically when its final
validated query has no rows. The diagnostic never calls an LLM; recall's existing query
translation remains the only model-dependent step.

Version 0.29 adds the same source-text-free `summary` to every why-not result and uses it
as the final answer for ordinary no-match recall, eliminating model-based negative
phrasing.

When the query already succeeds, `status` is `satisfied`, `failures` is empty, and
`explanation` contains the ordinary proof/source graph. When it is blocked, the result
contains:

- the requested and identity-projected query;
- the ordinary empty explanation, proving the exact evaluated surface;
- a failure tree for every eliminated conjunction binding and matching rule attempt;
- sourced `nearby` facts of the same predicate/arity; and
- a deterministic graph connecting query, failure, rule-attempt, and observed-fact nodes.

## Failure reasons

- `missing_fact`: no stored or derived fact matches the required positive literal and no
  matching rule branch can derive it;
- `rules_blocked`: one or more rules define the predicate, with their nested blockers;
- `negated_fact_present`: a grounded fact exists, so a `\+` premise cannot succeed;
- `comparison_false`: the fully grounded comparison or arithmetic filter is false;
- `recursive_cycle`: diagnosis reached the same resolved literal again;
- `rule_output_mismatch`: a rule body can succeed but its head does not match the requested
  repeated-variable or constant pattern; and
- `aggregate_result_mismatch`: contributors exist, but the derived aggregate output does
  not equal the requested result.

Nearby facts are deterministic observations, not similarity guesses. Candidates have the
same predicate and arity, rank by the number of equal grounded argument positions, then
retain materialization order. Each candidate carries the ordinary derivation proof,
durable sources, and explanation graph. Canonical identity and opt-in tentative trust are
projected exactly as on query/explain; default trust still hides tentative claims.

## Completeness and bounds

Diagnostics are complete only inside their declared finite boundaries and fail closed
rather than truncating:

- 32 failure nodes by default, maximum 128;
- rule-diagnostic depth 8 by default, maximum 32;
- 4 nearby candidates per failure by default, maximum 16;
- 16 distinct sourced evidence facts by default, maximum 64; and
- the existing fact, iteration, aggregate, proof, namespace, recorded-history, input, and
  16 MiB output limits.

The CLI exposes these as `--failure-limit`, `--diagnostic-depth`, `--candidate-limit`,
and `--evidence-limit`. A query with a larger intermediate binding frontier fails before
claiming a complete explanation. Recursive rules terminate through explicit cycle nodes
or the depth boundary.

Why-not evidence explains the selected closed-world Datalog program. It does not claim
that a missing real-world fact is false, infer a repair, or authorize a mutation. Combine
it with v0.23 `what-if` when evaluating a proposed factual correction, or v0.27 `repair`
to search grounded blockers for minimal verified proposals.
