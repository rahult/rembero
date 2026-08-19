# LongMemEval-S retrieval gate

Status: pinned retrieval-only measurement, 20 August 2026 AEST

Remembero now runs the complete cleaned LongMemEval-S split: 500 questions over
multi-session conversational histories. The runner measures whether deterministic local
source search finds the dataset's gold evidence sessions. It does not ask a model to form
memories or generate answers, so formation and answer quality remain outside this result.

## Reproduce it

```bash
npm run bench:longmemeval:download
npm run bench:longmemeval
npm run bench:longmemeval -- --json
```

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

## What is actually indexed

Each LongMemEval session is represented by one opaque `longmem_session(session_N).` carrier
fact. The full transcript is attached as durable source provenance with the dataset's real
session ID. `searchKnowledge` ranks those sources against the question and returns the
source session IDs. No answer text, gold evidence ID, model-generated memory, embedding, or
handwritten case data is placed in the query.

This deliberately measures the product's local source-search layer. It is not a substitute
for an end-to-end LongMemEval answer score.

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

Preference questions are the largest gap: 43.33% Recall@5 versus 92.86% for
single-session assistant facts and 95.31% for single-session user facts. That makes learned
semantic retrieval or a purpose-built preference index a concrete next experiment rather
than an unmeasured feature claim.

## Evidence boundary

This result establishes a reproducible, zero-provider-cost retrieval baseline on a broad
public dataset. It does not establish:

- answer accuracy, because no language model reads the retrieved sessions;
- memory-formation accuracy, because raw sessions are ranked as source records;
- superiority over another memory product under the same LongMemEval protocol;
- reliable abstention or strong preference retrieval;
- hosted, concurrent, or multi-tenant performance.

The next defensible gate is a pinned external adapter and a common answer-generation model,
reported separately from retrieval so formation, search, and answer failures remain visible.
