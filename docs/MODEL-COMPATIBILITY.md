# Model compatibility

Remembero keeps rule evaluation, proofs, graph construction, schema selection, and final
deterministic answer rendering local. The configured model translates natural-language
memory and recall requests; it is not the reasoning authority.

## Verified models

The following live OpenRouter comparisons were run on 2026-08-17 AEST. Every run used
temperature zero and the real storage/reasoning pipeline.

### Recall translation

The v0.47 grounded projection corpus has 26 cases and 100 distractor predicates:

| Model | Correct | Accuracy | Precision / recall / F1 | Budget exhausted | Errors | Observed seconds |
|---|---:|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 65.2 |
| `google/gemini-3.7-flash` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 129.6 |
| `anthropic/claude-sonnet-5` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 125.7 |
| `openai/gpt-5.4-mini` | 26/26 | 100.0% | 100.0% / 100.0% / 100.0% | 0 | 0 | 35.3 |

### Personal knowledge extraction

The v0.40 corpus has 15 exact mutation cases, including corrections, rules, tentative
trust, authority no-ops, and local secret rejection:

| Model | Correct | Accuracy | Mutation precision / recall / F1 | Safety | Errors | Observed seconds |
|---|---:|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | 15/15 | 100.0% | 100.0% / 100.0% / 100.0% | 100.0% | 0 | 22.0 |
| `google/gemini-3.7-flash` | 15/15 | 100.0% | 100.0% / 100.0% / 100.0% | 100.0% | 0 | 38.7 |
| `anthropic/claude-sonnet-5` | 15/15 | 100.0% | 100.0% / 100.0% / 100.0% | 100.0% | 0 | 48.8 |
| `openai/gpt-5.4-mini` | 14/15 | 93.3% | 91.7% / 91.7% / 91.7% | 100.0% | 0 | 13.1 |

Observed duration is diagnostic only. Provider load, routing, and model revisions can
change it, so it is not a release threshold.

## Recommendation

- Keep `openai/gpt-5.6-luna` as the default. It passed both checkpoints and was also the
  least expensive model in the catalog snapshot below.
- Use `google/gemini-3.7-flash` as the first verified fallback when independent provider
  diversity matters.
- `anthropic/claude-sonnet-5` also passed, but its catalog price was materially higher.
- GPT-5.4 Mini now passes the recall checkpoint after explicit relational projection, but
  it remains below the combined recommendation because it changed `dr_chen` to `chen` in
  the separate extraction checkpoint and costs more than the default catalog snapshot.

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

These evaluations measure question-to-query translation, exact retrieved bindings, and
exact personal-knowledge mutations. They do not compare final prose phrasing or broad
open-domain semantic coverage beyond the labeled cases.

The ranker deterministically treats `grandchild` and `grandparent` as the same
kinship concept for schema selection. This makes the authored `grandparent` rule and its
dependencies visible under a bounded 100-predicate distractor load. The prompt then asks
the model to query a matching derived head instead of leaking rule-local helper variables.
Evaluation still runs the accepted query over the complete selected knowledge view.
Version 0.47 additionally makes answer columns explicit, so valid inlined joins cannot
leak helper variables even when a model does not choose the derived head predicate.

Run the checkpoint yourself:

```bash
LLM_API_KEY="$OPENROUTER_API_KEY" npm run eval:recall -- \
  --models openai/gpt-5.6-luna,google/gemini-3.7-flash,anthropic/claude-sonnet-5,openai/gpt-5.4-mini \
  --variants grounded
LLM_API_KEY="$OPENROUTER_API_KEY" npm run eval:extract -- \
  --models openai/gpt-5.6-luna,google/gemini-3.7-flash,anthropic/claude-sonnet-5,openai/gpt-5.4-mini
```

Live zero-temperature runs can still move when a provider changes routing or model
weights. The deterministic corpus and scorer, rather than this dated result, remain the
repeatable release evidence.
