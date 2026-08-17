# Grounded deterministic negative recall

Rembero 0.29 removes the LLM from the final negative-answer step. The model may still
translate a natural-language question into a bounded Datalog query and receive the
existing one fallback chance when that query is empty. Once a final full-schema query is
accepted and still has no rows, local deterministic evidence owns the answer.

## Sequence

```text
question
  -> bounded schema selection
  -> validated Datalog query
  -> exact evaluation
  -> one translation-review fallback when empty
  -> optional full-schema widening
  -> final empty query
  -> deterministic why-not + local summary
```

Why-not is calculated only at the final step. Provisional empty queries do not pay the
diagnostic cost and their blockers never influence the model's fallback translation.

## Result contract

A complete negative result has:

- `status: "no_match"`;
- the final validated query and empty bindings;
- `whyNot`, including full blocker tree, nearby sourced facts, graph, and `summary`; and
- `answer` exactly equal to that deterministic summary.

Summaries include at most three distinct leaf blockers by default and never include
durable source text. They describe missing facts, present negation blockers, false
comparisons, recursion, or rule/aggregate output mismatch using canonical Datalog
evidence.

Answered recall is unchanged and still uses the existing grounded LLM phrasing step.
Structurally unanswerable and schema-budget-exhausted results retain their established
deterministic messages.

Version 0.30 can opt successful answers into local deterministic rendering as well.
Negative answers remain deterministic regardless of answer mode.

## Diagnostic limits

Why-not is additional evidence, not a precondition for the already-proven empty row set.
If its frontier, depth, proof, fact, or evidence limits raise `EngineLimitError`, recall
does not fail or ask an LLM to improvise. It returns:

```json
{
  "status": "no_match",
  "answer": "No stored result matches item(X), missing(X).",
  "whyNotUnavailable": {
    "reason": "diagnostic_limit",
    "message": "why-not diagnostic frontier exceeded 32 bindings"
  }
}
```

No partial blocker tree is returned. Other safety or consistency errors still fail
normally; only an explicit diagnostic resource limit falls back to the generic grounded
negative.

## Privacy and authority

Neither the blocker tree nor summary is sent to the external model. Credential checks on
the question and schema remain unchanged. Closed-world no-match means no result follows
from the selected stored program; it does not assert that a missing real-world fact is
false. Use `repair` only for proposal-only grounded changes and a separately authorized
write to change memory.
