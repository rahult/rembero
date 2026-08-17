# Natural-language evaluations

Rembero measures both personal-knowledge extraction and recall at deterministic evidence
boundaries. The extraction runner scores the exact store mutation after validation; the
recall runner scores exact engine bindings before answer phrasing.

## Extraction

Run the default model against the labeled extraction corpus:

```bash
npm run eval:extract
```

Compare models or select cases:

```bash
npm run eval:extract -- --models openai/gpt-5.6-luna,another/model
npm run eval:extract -- --cases replace_current_fact,derived_colleague_rule
npm run --silent eval:extract -- --json
```

Each case gets a fresh real `MemoryStore` and runs through `rememberText`. The 15-case
corpus covers exact facts, quoted and numeric values, schema reuse among 100 distractor
predicates, duplicates, replacement, removal, positive and negated rules, tentative
caller authority, non-factual input, policy and identity no-ops, and secret rejection
before any model call.

Rules are compared by alpha-equivalent canonical form, so harmless variable renaming does
not fail. Signed mutation precision/recall/F1 scores both added and removed clauses without
inflating results from unchanged initial facts. Exact-case accuracy additionally requires
the complete final state, added clauses, duplicate/retraction counts, expected rejection,
and the zero-call secret boundary to match.

## Recall

For recall, the live model translates each labeled question into Datalog, the real engine
evaluates it against a fixed memory corpus, and the runner compares the returned binding
rows with the expected rows. This isolates retrieval quality from prose style.

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

Both commands load `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` exactly like the product
CLI. Runs are sequential and use temperature zero, but they are still live-model
measurements: provider or model changes can move the result. The checked-in corpus,
labels, normalizer, and metric tests remain deterministic.

The v0.7 corpus adds 100 unrelated predicate families to the real memory program, so
every labeled case exercises the same bounded schema-selection path used by a scaled
personal knowledge base.

Version 0.19 adds four confusable non-empty cases where the wrong related predicate also
returns plausible rows: owner versus implementation language and home versus workplace.
These cases exercise the bounded query-review path as well as final evidence scoring.
Version 0.20 adds a reusable aggregate-predicate case, bringing the deterministic corpus
to 25 cases. Version 0.21 adds one explicitly tentative recall case, bringing it to 26;
that case runs with `include_tentative` while every other case retains the accepted view.

## Recall metrics

- **Accuracy**: percentage of cases with the correct query/unanswerable decision and an
  exact binding-row set.
- **Precision**: micro-averaged correct rows divided by all returned rows.
- **Recall**: micro-averaged expected rows that were returned.
- **F1**: harmonic mean of precision and recall.
- **Answerability**: whether the model correctly distinguishes a query the schema can
  express from a structurally unanswerable question. A valid query with no matching fact
  remains answerable and is distinct from `unanswerable`.
- **Schema budget exhaustion**: count of cases where bounded schema context could not
  establish a complete negative result. Exhaustion is always scored as incorrect rather
  than being confused with an accurate `unanswerable` decision.

Variable names and row order do not affect scoring. Multi-variable values retain the
variables' first-appearance order in the generated query, so swapping semantic roles does
not pass. Rows are deduplicated before comparison. A ground query that is true is
represented by one empty binding row; a ground query that is false has no rows. Scored
facts are held out from the sample facts included in the model-visible schema summary.

## Last live comparison

### Extraction

Measured on 2026-08-17 AEST with the v0.40 extraction contract:

| Model | Cases | Accuracy | Mutation precision | Mutation recall | Mutation F1 | Safety | Unexpected errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | 15 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `google/gemini-3.7-flash` | 15 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `anthropic/claude-sonnet-5` | 15 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `openai/gpt-5.4-mini` | 15 | 93.3% | 91.7% | 91.7% | 91.7% | **100.0%** | **0** |

GPT-5.4 Mini changed `dr_chen` to `chen` in the quoted-city case. The other three
models produced the exact expected mutations in this run.

### Recall

Measured on 2026-08-17 AEST with the v0.39 grounded prompt and deterministic schema
ranker. All 26 current cases ran among 100 distractor predicates with no schema-budget
exhaustion or transport errors:

| Model | Cases | Accuracy | Precision | Recall | F1 | Answerability | Budget exhausted |
|---|---:|---:|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | 26 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `google/gemini-3.7-flash` | 26 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `anthropic/claude-sonnet-5` | 26 | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0** |
| `openai/gpt-5.4-mini` | 26 | 92.3% | 92.0% | 92.0% | 92.0% | **100.0%** | **0** |

GPT-5.4 Mini exposed helper variables while inlining the `colleague` and `grandparent`
rule bodies. See [model compatibility](MODEL-COMPATIBILITY.md) for the recommendation,
observed catalog prices, latency, and evidence boundary.

The earlier pre-0.4, pre-scale baseline comparison was:

| Prompt | Accuracy | Precision | Recall | F1 | Answerability |
|---|---:|---:|---:|---:|---:|
| baseline | 94.7% | 94.4% | 100.0% | 97.1% | 94.7% |
| grounded (default) | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |

The baseline failure answered a causal “why” question with a related fact. The grounded
prompt now treats schema examples only as syntax evidence, keeps named entities fixed,
distinguishes yes/no questions from requested unknowns, and requires a causal predicate
for causal questions. The shared fallback prompt separately distinguishes valid empty
retrievals from structurally unanswerable questions.

The scaled run is a current-tree checkpoint, not a statistical guarantee. Provider or
model changes can move it, which is why the deterministic corpus and scorer remain the
release gate.

This corpus is deliberately small and diagnostic rather than statistically representative.
Add a labeled case whenever a real recall failure is found, and compare against the
baseline before changing the default prompt.
