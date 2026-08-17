# Model compatibility

Rembero keeps rule evaluation, proofs, graph construction, schema selection, and final
deterministic answer rendering local. The configured model translates natural-language
memory and recall requests; it is not the reasoning authority.

## Verified recall models

The following live OpenRouter comparison was run on 2026-08-17 AEST against the v0.39
grounded 26-case corpus with 100 distractor predicates. Every run used temperature zero,
the real bounded schema selector, and the real Datalog engine.

| Model | Correct | Accuracy | Precision / recall / F1 | Budget exhausted | Errors | Observed seconds |
|---|---:|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 59.9 |
| `google/gemini-3.7-flash` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 131.4 |
| `anthropic/claude-sonnet-5` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 139.6 |
| `openai/gpt-5.4-mini` | 24/26 | 92.3% | 92.0% / 92.0% / 92.0% | 0 | 0 | 37.2 |

Observed duration is diagnostic only. Provider load, routing, and model revisions can
change it, so it is not a release threshold.

## Recommendation

- Keep `openai/gpt-5.6-luna` as the default. It passed this recall checkpoint and was
  also the least expensive model in the catalog snapshot below.
- Use `google/gemini-3.7-flash` as the first verified fallback when independent provider
  diversity matters.
- `anthropic/claude-sonnet-5` also passed, but its catalog price was materially higher.
- Do not recommend `openai/gpt-5.4-mini` for grounded recall at this checkpoint. It twice
  returned helper variables from inlined rule bodies, producing plausible but incorrect
  answer columns.

The OpenRouter catalog snapshot observed during the same session listed these prices per
million tokens:

| Model | Input | Output |
|---|---:|---:|
| `openai/gpt-5.6-luna` | $0.10 | $0.60 |
| `google/gemini-3.7-flash` | $0.375 | $1.875 |
| `openai/gpt-5.4-mini` | $0.75 | $4.50 |
| `anthropic/claude-sonnet-5` | $2.00 | $10.00 |

These prices are a dated catalog observation, not a billing guarantee. Check OpenRouter
before making a purchasing decision.

## Boundary of the evidence

This evaluation measures question-to-query translation and exact retrieved bindings. It
does not compare natural-language fact extraction or final prose phrasing. Do not change
the default model solely from this table without running extraction cases as well.

The v0.39 ranker deterministically treats `grandchild` and `grandparent` as the same
kinship concept for schema selection. This makes the authored `grandparent` rule and its
dependencies visible under a bounded 100-predicate distractor load. The prompt then asks
the model to query a matching derived head instead of leaking rule-local helper variables.
Evaluation still runs the accepted query over the complete selected knowledge view.

Run the checkpoint yourself:

```bash
LLM_API_KEY="$OPENROUTER_API_KEY" npm run eval:recall -- \
  --models openai/gpt-5.6-luna,google/gemini-3.7-flash,anthropic/claude-sonnet-5,openai/gpt-5.4-mini \
  --variants grounded
```

Live zero-temperature runs can still move when a provider changes routing or model
weights. The deterministic corpus and scorer, rather than this dated result, remain the
repeatable release evidence.
