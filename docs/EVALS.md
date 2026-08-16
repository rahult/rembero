# Recall evaluations

Rembero measures natural-language recall at the evidence boundary, before answer phrasing.
The live model translates each labeled question into Datalog, the real engine evaluates it
against a fixed memory corpus, and the runner compares the returned binding rows with the
expected rows. This isolates retrieval quality from prose style.

Run the default model against both prompt variants:

```bash
npm run eval:recall
```

Compare models or select cases:

```bash
npm run eval:recall -- --models openai/gpt-5.6-luna,another/model
npm run eval:recall -- --cases direct_employer,derived_colleague
npm run --silent eval:recall -- --json
```

The command loads `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` exactly like the product
CLI. Runs are sequential and use temperature zero, but they are still live-model
measurements: provider or model changes can move the result. The checked-in corpus,
labels, normalizer, and metric tests remain deterministic.

## Metrics

- **Accuracy**: percentage of cases with the correct query/unanswerable decision and an
  exact binding-row set.
- **Precision**: micro-averaged correct rows divided by all returned rows.
- **Recall**: micro-averaged expected rows that were returned.
- **F1**: harmonic mean of precision and recall.
- **Answerability**: whether the model correctly distinguishes a query the schema can
  express from a structurally unanswerable question. A valid query with no matching fact
  remains answerable and is distinct from `unanswerable`.

Variable names and row order do not affect scoring. Multi-variable values retain the
variables' first-appearance order in the generated query, so swapping semantic roles does
not pass. Rows are deduplicated before comparison. A ground query that is true is
represented by one empty binding row; a ground query that is false has no rows. Scored
facts are held out from the sample facts included in the model-visible schema summary.

## Current comparison

Measured on 2026-08-17 AEST (2026-08-16 UTC) with `openai/gpt-5.6-luna`, 19 cases,
and the current code:

| Prompt | Accuracy | Precision | Recall | F1 | Answerability |
|---|---:|---:|---:|---:|---:|
| baseline | 94.7% | 94.4% | 100.0% | 97.1% | 94.7% |
| grounded (default) | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |

The baseline failure answered a causal “why” question with a related fact. The grounded
prompt now treats schema examples only as syntax evidence, keeps named entities fixed,
distinguishes yes/no questions from requested unknowns, and requires a causal predicate
for causal questions. The shared fallback prompt separately distinguishes valid empty
retrievals from structurally unanswerable questions.

This corpus is deliberately small and diagnostic rather than statistically representative.
Add a labeled case whenever a real recall failure is found, and compare against the
baseline before changing the default prompt.
