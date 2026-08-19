# LongMemEval-S retrieval and answer gates

Status: pinned retrieval and live end-to-end measurements, 20 August 2026 AEST

Remembero now runs the complete cleaned LongMemEval-S split: 500 questions over
multi-session conversational histories. The zero-provider runner measures deterministic
source retrieval. The live runner separately measures durable raw-session formation,
retrieval, answer generation, and task-specific answer judging so a strong retrieval score
cannot be presented as end-to-end accuracy.

## Reproduce it

```bash
npm run bench:longmemeval:download
npm run bench:longmemeval
npm run bench:longmemeval -- --json
npm run bench:longmemeval:answer -- --split dev --output /tmp/remembero-lme-dev.json
npm run bench:longmemeval:answer -- --split test --output /tmp/remembero-lme-test.json
```

The answer runner requires `LLM_API_KEY`, uses provider budget, and stays outside CI and
`prepublishOnly`. It defaults to the development partition. Run held-out only after the
policy is locked.

The download is pinned to dataset commit
`98d7416c24c778c2fee6e6f3006e7a073259d48f` and rejected unless its SHA-256 is
`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
The 277,383,467-byte dataset is cached under `.cache/`, never committed, and not needed by
normal tests or package installation.

## Current result

Default configuration: top five sessions, 16,384 source characters indexed per session,
minimum score 1.

| Metric | Result |
| --- | ---: |
| Questions | 500 |
| Answerable / abstention | 470 / 30 |
| Precision@5 | 30.72% |
| Recall@5 | 83.27% |
| Mean reciprocal rank | 80.96% |
| All gold sessions retrieved | 75.32% |
| Abstention queries returning no sessions | 0.00% |
| Local search p50 / p95 | 9.90 / 10.78 ms |
| Model / embedding / remote calls | 0 / 0 / 0 |

Three complete runs produced identical semantic metrics. Their p95 latency was
10.61–11.10 ms on an Apple M4 with Node 26.5. Timing is diagnostic and excludes dataset
loading and the one-time conversion of each question's sessions into source records.

The machine-readable measurement is
[`results/longmemeval-s-retrieval-v1-summary.json`](results/longmemeval-s-retrieval-v1-summary.json).

## End-to-end answer result

Each question gets a fresh real `MemoryStore`. Every timestamped session is committed as a
durable `longmem_session/1` fact with its transcript as source provenance. Remembero then
reconstructs the snapshot, retrieves four sessions, and sends at most 56 KiB of safe context
to the reader. Factual questions are history-only. Preference questions may combine recalled
personal context with general recommendation knowledge, but may not invent user details.

The policy was selected on a deterministic SHA-256 development partition, then run once on
the untouched held-out partition:

| Partition | Correct | Accuracy | Recall@4 | All-evidence answer accuracy | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development | 206 / 261 | 78.9% | 85.8% | 92.6% | 0 |
| Held-out | 171 / 239 | 71.5% | 81.7% | 85.9% | 0 |
| Combined | 377 / 500 | 75.4% | 83.8% | 89.5% | 0 |

The 42.3% combined accuracy when evidence was incomplete, versus 89.5% when it was
complete, identifies retrieval coverage—not polished answer prose—as the largest remaining
lever.

| Question type | Questions | Accuracy |
| --- | ---: | ---: |
| Single-session user | 70 | 94.3% |
| Single-session assistant | 56 | 92.9% |
| Single-session preference | 30 | 90.0% |
| Knowledge update | 78 | 80.8% |
| Temporal reasoning | 133 | 70.7% |
| Multi-session | 133 | 56.4% |

The live reader was `openai/gpt-5.6-luna`; recommendation intent alone could use the
selected Perplexity 0.6B embedder. The reader plus embeddings cost $1.371122 for all 500
questions, or $0.002742 per production-style answer. The separate
`openai/gpt-4o-2024-08-06` judge cost $0.161905. Provider-native usage—not catalog-price
multiplication—supplies every total.

Durable formation p95 was 180 ms and the 471 local retrievals had 11.5 ms p95. Cold
semantic preference retrieval was the slow path. After independent embedding batches were
bounded to concurrency three, a five-question development pilot retained 5/5 answers while
reducing semantic retrieval p50/p95 to 8.4/9.0 seconds and end-to-end p50/p95 to
16.3/24.5 seconds. Explicit `prepare_semantic_search` can move document work off the user
turn in a long-lived agent harness.

The machine-readable decision and result is
[`results/longmemeval-answer-v1-summary.json`](results/longmemeval-answer-v1-summary.json).
The runner can also emit the upstream two-field hypothesis JSONL. Its internal judge is
task-specific and official-compatible; this result was not independently rescored through
the upstream Python script. See the
[official benchmark and evaluator](https://github.com/xiaowu0162/LongMemEval).

## What is actually indexed

Each LongMemEval session is represented by one opaque `longmem_session(session_N).` carrier
fact. The full transcript is attached as durable source provenance with the dataset's real
session ID. `searchKnowledge` ranks those sources against the question and returns the
source session IDs. No answer text, gold evidence ID, model-generated memory, embedding, or
handwritten case data is placed in the query.

This representation is also used by the answer runner, but through real durable store
writes and snapshot reconstruction rather than an in-memory source map shortcut. It proves
raw-session formation, not model-extracted structured-fact accuracy.

## Why the default source window changed

The former 4,096-character window truncated 97.6% of gold session occurrences. In the
pinned dataset, 198 labelled answer turns begin after character 4,096 and 89 begin after
8,192. The median session is 14,393 characters; p95 is 19,476 and the maximum is 28,108.

The same code and dataset produced:

| Characters per source | Precision@5 | Recall@5 | MRR | All evidence | p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4,096 | 29.21% | 79.67% | 78.10% | 70.00% | 5.30 ms |
| 8,192 | 30.00% | 82.70% | 81.96% | 74.26% | 9.09 ms |
| 16,384 | 30.72% | 83.27% | 80.96% | 75.32% | 10.29 ms |
| 32,768 | 30.81% | 83.33% | 80.63% | 75.32% | 10.41 ms |

The 16 KiB default captures nearly all of the 32 KiB recall gain without making 32 KiB the
ordinary cost. Search also caps aggregate source text considered in one call at 32 MiB and
reports both requested and effective per-source limits.

Conversational stopwords are removed before ranking. On the same 4 KiB window, that change
raised Recall@5 from the pre-change 74.97% measurement to 79.67% and strict all-evidence
coverage from 63.40% to 70.00%.

## Precision and abstention are visible weaknesses

`minimumScore` is an explicit search option and benchmark flag. The threshold frontier is
published instead of selecting the best value after seeing the full test set:

| Minimum score | Precision@5 | Recall@5 | MRR | All evidence | Abstention empty |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 30.72% | 83.27% | 80.96% | 75.32% | 0.00% |
| 90 | 32.67% | 82.46% | 80.67% | 74.47% | 3.33% |
| 135 | 38.34% | 78.79% | 78.86% | 70.64% | 20.00% |
| 180 | 42.46% | 70.33% | 72.44% | 61.91% | 36.67% |

The product keeps the recall-first default. Developers can raise the threshold when false
context is more expensive than missed context, but the current lexical search does not yet
provide reliable abstention.

In the retrieval-only baseline, preference questions are the largest gap: 43.33% Recall@5 versus 92.86% for
single-session assistant facts and 95.31% for single-session user facts. That makes learned
semantic retrieval or a purpose-built preference index a concrete next experiment rather
than an unmeasured feature claim.

That experiment is now measured. A locked recommendation-intent policy using the opt-in
semantic tool raises all-preference Recall@5 to 73.33% and held-out Recall@5 from 46.67% to
60.00%. It does not change the recall-first lexical default or use similarity for
abstention. See [semantic knowledge search](../SEMANTIC-KNOWLEDGE-SEARCH.md) for the split,
cost, cache, and export-safety boundary.

## Evidence boundary

The retrieval result remains the reproducible zero-provider baseline. The answer result adds
live raw-session formation and QA evidence, but it does not establish:

- learned structured-fact formation accuracy over the complete transcript stream;
- superiority over another memory product under the same reader, judge, and policy;
- deterministic generation or judging—one development preference slice moved between
  repeated temperature-zero runs, so live-model variance remains real;
- reliable multi-session aggregation or learned abstention confidence;
- hosted, concurrent, multi-tenant, or sustained-provider performance.

The held-out run initially contained one provider HTTP 400 caused by a lone UTF-16 high
surrogate in source text. Provider-boundary Unicode scalar normalization fixed the defect;
the exact case was retried without changing retrieval, prompts, models, or scoring. The
final 239-question held-out artifact has zero errors. This repair is disclosed in the
machine-readable result rather than silently dropping the case.
