# LongMemEval-V2 fresh agentic-memory pilot

Status: pinned official-harness text-only pilot, 20 August 2026 AEST

This is Remembero's first fresh evaluation on
[LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2), an agentic-memory benchmark
over web and enterprise trajectories. It is separate from LongMemEval-S: the backend
receives complete browser-agent trajectories and returns compact context to the benchmark's
fixed reader.

## Pinned contract

- Official harness commit: `2cc8c540bdb87fe6761629b585e727e1c4704520`
- Dataset: `xiaowu0162/longmemeval-v2`
- Questions SHA-256: `0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7`
- Trajectories SHA-256: `363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6`
- Small haystack SHA-256: `9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593`

The text corpus is 1.20 GB. The small tier shares 100 trajectories per domain. Screenshot
archives total about 5.9 GB and were not downloaded for this text-only pilot.

## Adapter

The [official adapter](../../benchmarks/adapters/longmemeval-v2/README.md) implements
`Memory.insert` and `Memory.query` without modifying the benchmark harness:

1. each state is split into at most twenty-four overlapping 4,096-character chunks;
2. a bounded BM25-style state shortlist groups terms across those chunks;
3. Remembero's real local source scorer ranks chunks inside the shortlist;
4. at most two states per trajectory and up to three best chunks from each of six states are returned to the reader;
5. memory retrieval uses zero model and embedding calls.

The backend receives no question ID, type, gold answer, or evaluator configuration. Question
images are explicitly ignored and reported in metadata; multimodal support is not claimed.

## Fresh selection

One question (`01307e07`) was used during adapter development and excluded from evidence.
The pilot then selected text-only enterprise questions with deterministic official scorers,
sorted by SHA-256 of question ID, and took the first ten. The frozen adapter was rerun once
on that set through the official harness.

| Method | Correct | Accuracy | Unknown rate | Memory-query p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| Official no retrieval | 0 / 10 | 0% | 100% | 0.004 / 0.025 ms |
| Remembero lexical state search v2 | 3 / 10 | 30% | 60% | 105 / 133 ms |

The current lexical v2 six static questions scored 33.3%, two dynamic questions scored
50%, and two procedure questions scored 0%. The reader was the benchmark's fixed
`qwen/qwen3.5-9b` configuration through OpenRouter. Remembero supplied an average 19,015
memory-context tokens; no context was truncated. Reader usage was 192,075 prompt and 35,126
completion tokens. Memory retrieval itself made no provider call and had zero operational
errors.

The machine-readable result is
[`results/longmemeval-v2-fresh10-lexical-v2-summary.json`](results/longmemeval-v2-fresh10-lexical-v2-summary.json).

The original v1 frozen expansion used the prefix-only adapter on 50 text-only enterprise
questions. It scored 10/50 (20.0%) with 89.6 ms average and 122 ms p95 memory-query
latency, zero provider calls inside memory, and zero operational errors. Category accuracy
is 20.7% static, 10.0% dynamic, and 27.3% procedure. The reader received an average
18,717 context tokens and used 945,908 prompt plus 223,663 completion tokens.

That larger result is historical v1 evidence, not a score for the current v2 chunk/diversity
configuration. It is not compared to a same-question no-retrieval run, so the only
supported causal comparison is the original pilot's 3/10 versus 0/10 baseline. See
[`results/longmemeval-v2-fresh50-summary.json`](results/longmemeval-v2-fresh50-summary.json).

## Prepared semantic state lane

The lexical adapter can be run with the separate
[`memory_config.semantic.json`](../../benchmarks/adapters/longmemeval-v2/memory_config.semantic.json)
when retrieval quality justifies a measured embedding-maintenance cost. This lane embeds
bounded state summaries after the shared 100-trajectory insert phase, then combines the
semantic shortlist with local lexical source ranking. It keeps provider work out of the
measured user turn and reports usage separately.

On the same ten fresh text-only enterprise questions, the prepared state lane scored 6/10
(60.0%), versus 3/10 for the lexical pilot. Static, dynamic, and procedure accuracy were
50.0%, 100.0%, and 50.0%. Memory-query p95 was 512 ms. Index maintenance took 46.8 seconds
for 3,358 states and cost $0.005382 for the shared haystack (1,345,489 embedding tokens).
The fixed Qwen3.5-9B reader ran with four concurrent requests; no memory model calls were
made.

The machine-readable result is
[`results/longmemeval-v2-fresh10-semantic-state-summary.json`](results/longmemeval-v2-fresh10-semantic-state-summary.json).

This is an accuracy/cost operating point, not a default replacement: it requires an
embedding provider, has a maintenance phase, and has only ten questions of evidence. The
lexical path remains the zero-provider-cost baseline.

## Evidence boundary

These results prove that the adapter conforms to the official privacy boundary and that a
prepared state-semantic operating point improves the same reader from 3/10 lexical to 6/10
on one fresh text-only subset. They do not establish:

- leaderboard performance or statistical significance;
- web-domain, medium-tier, screenshot, or multimodal quality;
- parity with the paper's local reader endpoint despite using the same model ID;
- learned workflow/runbook formation; the current adapter indexes bounded raw states;
- superiority over the official RAG or AgentRunbook baselines.

The next defensible expansion is a larger frozen text-only set covering abstention and
gotchas, followed by a multimodal design rather than silently omitting question images.
