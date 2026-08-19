# Agent database scorecard

Status: executable v1 gate, measured 20 August 2026 AEST

Remembero's product objective is to be an excellent database for agents across five
dimensions: usage, integration ease, answer accuracy, speed, and cost. This scorecard
turns those dimensions into explicit current-tree evidence.

It is a conformance and integration gate, not a claim of universal superiority over
commercial systems that have not been run through the same protocol.

## Run it

```bash
npm run bench:agent-db
npm run bench:agent-db:check
npm run bench:agent-db -- --json --repetitions 20
npm run bench:agent-db:install:check
```

`bench:agent-db:check` builds the current package, repeats the deterministic structured
memory suite, starts the compiled `remembero serve` process over stdio, discovers its MCP
tools, seeds memory through MCP, and executes a real `explain_query` proof round trip.

## Current result

Measured on this checkout with ten engine repetitions and one fresh MCP process:

| Dimension | Metric | Result | Gate |
| --- | --- | ---: | ---: |
| Accuracy | Exact structured answers | 100.0% | 100% |
| Accuracy | Answerability | 100.0% | 100% |
| Accuracy | Retrieval Precision@k | 100.0% | 100% |
| Accuracy | Citation recall | 100.0% | 100% |
| Accuracy | Stale leakage | 0.0% | 0% |
| Broad retrieval | LongMemEval-S Recall@5 / MRR | 83.27% / 80.96% | measured |
| Broad retrieval | Strict all-evidence coverage | 75.32% | measured |
| Speed | Engine p50 | 0.03 ms | diagnostic |
| Speed | Engine p95 | 0.54 ms | <= 25 ms |
| Speed | MCP process startup | 93.74 ms | diagnostic |
| Speed | MCP explain round trip | 7.95 ms | <= 500 ms |
| Scale | Maximum gated facts | 100,000 | >= 100,000 |
| Scale | 100k parse/load | 97.22 ms | <= 2,000 ms |
| Scale | Maximum query p95 | 81.70 ms | <= 250 ms |
| Scale | Maximum proof p95 | 64.78 ms | <= 500 ms |
| Million-fact gate | Query / proof p95 | 1.014 s / 1.011 s | <= 3.0 s / <= 3.0 s |
| Million-fact gate | Process max RSS | 2.15 GiB | <= 2.5 GiB |
| Cost | Model calls per structured query | 0 | 0 |
| Cost | Embedding calls per structured query | 0 | 0 |
| Cost | Remote calls / required API keys | 0 / 0 | 0 / 0 |
| Natural-language cost | Recall, Luna, 26 cases | $0.016735 total / $0.000644 avg | measured |
| Natural-language cost | Extraction, Luna, 15 cases | $0.003306 total / $0.000220 avg | measured |
| Ease | Setup commands | 2 | contract |
| Ease | Discovered MCP tools | 35 | includes required read tools |
| Preference retrieval | LongMemEval-S Recall@5 | 43.3% → 66.7% | measured semantic policy |
| Preference retrieval | Held-out Recall@5 / MRR | 53.3% / 45.6% | measured |
| Semantic cost | 22 routed questions | $0.007999824 | measured |
| Semantic cost | Restart cache provider tokens | 32 → 9 | measured |
| Ease | Cold empty-cache npm install | 5.19 s | <= 120 s diagnostic gate |
| Ease | First CLI write / proof query | 89.08 ms / 95.46 ms | <= 1,000 ms each |
| Ease | Packed / installed size | 0.92 MiB / 3.81 MiB | diagnostic |

Semantic evidence digest:

```text
85448a68f2a141a8d9b681267365c576c9e072099165568e8f6f03d6ff3807de
```

Timings are current-machine diagnostics. The semantic digest excludes timing and remains
stable across repeated runs with the same suite and implementation.

## What each dimension proves

### Usage

- A real MCP client starts the compiled stdio server.
- The client discovers `explain_query` and `recall_explain`.
- Memory is seeded through `assert_facts`, not an internal shortcut.
- `explain_query` returns the expected Atlas/Maya answer and supporting owner/contributor
  proof through the protocol.

### Ease

The supported narrow path is:

```bash
npm install -g remembero
remembero serve
```

An agent harness then calls one MCP read tool. Structured query and proof require no
provider configuration. The separate [agent harness guide](AGENT-HARNESS.md) covers tool
validation, final prompting, and proposal-only writes.

The clean-install benchmark strengthens that contract beyond an in-tree invocation. It
packs the current npm artifact, installs it into a fresh directory with a fresh empty cache
and lifecycle scripts disabled, then runs the installed `remembero` binary. A real rule write
and first `explain` query must return Maya/Atlas plus `project_owner` and
`project_contributor` support. The benchmark passes only if install, write, and query remain
inside generous diagnostic limits and it passes no LLM credentials to the CLI.

Across four recorded Apple M4 / 16 GiB runs with Node 26.5 and npm 11.17, cold install
completed in 4.74–5.19 s, first write in 89.08–90.40 ms, and first proof query in
94.74–98.33 ms. The
latest packed artifact was 0.92 MiB and the installed package was 3.81 MiB. npm registry download
time is machine/network specific; the exact result is recorded in
[`research/results/clean-install-v1-summary.json`](research/results/clean-install-v1-summary.json).
The GitHub-hosted Ubuntu/Node 24 gate also passed: 3.00 s cold install, 210.71 ms first
write, and 224.03 ms first proof query.
The Windows/Node 24 gate passed the same complete web/package build and packed CLI flow:
32.33 s cold install, 359.54 ms first write, and 353.19 ms first proof query. All remain
inside the 120 s / 1 s cross-platform budgets.

### Accuracy

The underlying structured-memory suite covers direct recall among 100 distractor
predicates, rule derivation, recursion, temporal updates, honest abstention, explicit
trust views, provenance, and integrity conflict detection. The release gate requires:

- 100% exact typed answer rows;
- 100% answerability accuracy;
- 100% retrieval precision and recall at the published top-k;
- 100% citation precision and recall;
- zero stale evidence leakage;
- zero operational errors.

### Speed

The engine p95 gate is deliberately generous relative to the current sub-millisecond
result so ordinary CI variance does not create false failures. The MCP gate includes
JSON-RPC, process transport, storage, query evaluation, proof construction, and response
serialization.

Neither number includes model translation or final answer phrasing.

The default scale sweep additionally parses and evaluates selective proof-carrying queries
at 1,000, 10,000, 50,000, and 100,000 facts. It requires identical rows and proofs,
relation-index use, at most ten visited candidates, parse/load under two seconds, query p95
under 250 ms, and proof p95 under 500 ms.

```bash
npm run bench:agent-db:scale -- --check
npm run bench:agent-db:scale -- --facts 100000,250000 --repetitions 3
```

The separate million-fact gate runs three query and proof repetitions with a 4 GiB V8
ceiling and reports process max RSS:

```bash
npm run bench:agent-db:million
```

Two fresh-process runs on this checkout produced exact rows and proofs over a 33.17 MiB
program, used indexed lookup, and visited six candidates. Parse/load was 998–1,044 ms,
query p95 1,014 ms, proof p95 1,010–1,011 ms, and process max RSS 2.145–2.152 GiB.
The benchmark drops the textual corpus after parsing and requests collection before timed
evaluation, avoiding about 450 MiB of unrelated retained source/allocation memory. The gate
fails above 3,000 ms parse/query/proof or 2.5 GiB max RSS. The timing ceiling was calibrated
against a GitHub-hosted Ubuntu/Node 24 run (2,232 ms parse, 2,564 ms query p95, 2,049 ms
proof p95) rather than the faster local machine. Exact measurements and
the boundary are recorded in
[`research/results/million-scale-v1-summary.json`](research/results/million-scale-v1-summary.json).
The final hosted gate passed at 2,197 ms parse, 2,458 ms query p95, 2,047 ms proof p95,
and 2.188 GiB max RSS.

### Cost

The structured `query` and `explain_query` paths use:

```text
0 model calls
0 embedding calls
0 remote network calls
0 API keys
$0 marginal provider cost
```

Natural-language `remember`, `recall`, and `recall_explain` may call the configured model.
Their provider token cost is outside this zero-cost boundary. OpenRouter usage metadata is
now preserved per response and aggregated by both live eval runners without another API call.

Measured 20 August 2026 AEST with provider-reported usage and the grounded prompt's new
eight-predicate detailed schema budget:

| Path | Model | Cases | Accuracy | Input tokens | Output tokens | Seconds | Charged cost | Average |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Recall | `openai/gpt-5.6-luna` | 26 | 100% | 122,686 | 1,934 | 92.8 | $0.016735 | $0.000644/query |
| Extraction | `openai/gpt-5.6-luna` | 15 | 100% | 13,129 | 442 | 30.0 | $0.003306 | $0.000220/write |

A five-case direct/derived/recursive/negative/unanswerable recall slice compared all four
previously verified models under the same eight-predicate budget:

| Model | Accuracy | Input tokens | Output tokens | Seconds | Charged cost | Average/query |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `openai/gpt-5.6-luna` | 100% | 29,014 | 339 | 23.7 | $0.001004 | $0.000201 |
| `google/gemini-3.7-flash` | 100% | 33,178 | 1,553 | 34.0 | $0.015354 | $0.003071 |
| `openai/gpt-5.4-mini` | 100% | 26,816 | 127 | 11.2 | $0.016018 | $0.003204 |
| `anthropic/claude-sonnet-5` | 100% | 40,109 | 156 | 32.9 | $0.081778 | $0.016356 |

The default model was about 15x cheaper per query than the next-lowest charged result in
this slice. Provider routing and prices can change; rerun rather than treating the table as
a billing guarantee. OpenRouter documents that non-streaming responses include native
token counts and charged cost automatically:
<https://openrouter.ai/docs/cookbook/administration/usage-accounting>.

```bash
npm run bench:agent-db:cost
npm run eval:extract -- --models openai/gpt-5.6-luna
```

The full grounded prompt at the previous 32-predicate detailed budget cost $0.022549 for
the same 26 cases. Reducing the default detailed slice to eight retained 100% correctness
and lowered charged cost by 25.8%. A compact-instruction experiment was rejected: it was
slower and saved only 2.8%, confirming that detailed schema samples—not instruction prose—
were the material cost lever.

## Pinned external comparisons

`npm run bench:memory:langgraph` executes an externally maintained agent-memory store
through the same private-label protocol. The bridge pins LangGraph 1.2.10, FastEmbed 0.8.0,
and the 384-dimensional `BAAI/bge-small-en-v1.5` model. It creates a fresh LangGraph
`InMemoryStore`, embeds event text locally, and returns ranked fixture event IDs. The
manifest explicitly declares typed answers, rules, and citations unsupported, so those
metrics remain not applicable instead of being scored as zero or silently synthesized.

Measured 20 August 2026 AEST on Apple M4 / 16 GiB, after the 67 MB model was cached:

| Adapter | Precision@k | Recall@k | MRR | Exact typed answers | Citation recall | p95 | Model calls / cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Remembero engine | 100% | 100% | 100% | 100% | 100% | 1.77 ms | 0 / $0 |
| LangGraph `InMemoryStore` + FastEmbed | 88.6% | 100% | 100% | not applicable | not applicable | 254.04 ms | 0 / $0 |
| LlamaIndex `VectorMemory` + FastEmbed | 88.6% | 100% | 100% | not applicable | not applicable | 299.87 ms | 0 / $0 |
| Mem0 OSS + Luna + FastEmbed | 88.6% | 100% | 100% | not applicable | not applicable | 322.89 s | 118 / $0.044034 |
| Graphiti OSS + Luna + FastEmbed | 57.1% | 44.0% | 57.1% | not applicable | not applicable | 33.15 s | 275 / $0.037854 |

Remembero matched LangGraph, LlamaIndex, and Mem0's retrieval result while also returning
exact typed answers and proof citations. It also returned only relevant evidence; those
three vector-store adapters returned four distractors beside the target in the direct fact
top-five, reducing mean Precision@k to 88.6%. Graphiti's separately formed graph retrieved
less complete evidence, as detailed below. The timing paths are disclosed rather than
treated as identical:
Remembero parses/evaluates/proves the structured question, while LangGraph creates a fresh
store, embeds all case events, and runs vector search; dependency/model initialization is
excluded from its `wallMs`. This is a real external result, not a general framework or
commercial-system superiority claim. The second pinned adapter uses LlamaIndex 0.14.23's
`VectorMemory` and official FastEmbed integration under the same retrieval policy. Three warm
runs put its p95 between 291 and 531 ms; 319.97 ms is the recorded machine-readable run.
LangGraph documents custom embedding functions and semantic `Store.search`; LlamaIndex
documents its in-memory vector-store path; FastEmbed documents the exact BGE-small model and
its 384 dimensions:
<https://reference.langchain.com/python/langgraph.store/memory/InMemoryStore>,
<https://docs.llamaindex.ai/en/stable/community/integrations/vector_stores/>,
<https://qdrant.github.io/fastembed/Getting%20Started/>.

The Mem0 result exercises native memory formation rather than raw event storage. It pins
Mem0 OSS 2.0.14, runs Luna once per allowed event, embeds locally, persists to local Qdrant
and SQLite, then searches. The corrected full run used 118 model calls, 941,841 input and
12,855 output tokens, and $0.044034 provider-reported cost. A second full run was within
$0.00051 and 27 seconds p95. Because Remembero's memory-stack adapter consumes supplied
clauses while Mem0 forms memories from event text, the 323-second Mem0 p95 is a product
ingestion diagnostic—not a direct structured-query speed ratio. Mem0 documents this
LLM/embedder/vector-store composition and OpenRouter compatibility:
<https://docs.mem0.ai/open-source/configuration>,
<https://docs.mem0.ai/components/llms/models/openai>.

The Graphiti result uses native `add_episode_bulk`, hybrid edge search, and native
edge-to-episode provenance with Graphiti OSS 0.29.3. Luna forms the graph through
OpenRouter; FastEmbed and a fresh embedded FalkorDBLite graph stay local. The complete run
used 275 model calls, 395,591 input and 15,620 output tokens, cost $0.037854, and achieved
57.1% Precision@k, 44.0% Recall@k, and 57.1% MRR. It found the direct fact among 100
distractors, but omitted policy/rule episodes and returned no relevant evidence on the
explicit trust and integrity cases. The 33.15-second p95 includes native formation,
provider latency, local embedding, graph persistence, and retrieval—not just search.
The exact result and a materially higher-cost direct-case rerun are published in
[`research/results/graphiti-oss-v1-summary.json`](research/results/graphiti-oss-v1-summary.json).
The pinned Graphiti source and official FalkorDB quickstart expose the APIs used by the
bridge: <https://github.com/getzep/graphiti/tree/v0.29.3>,
<https://github.com/getzep/graphiti/blob/v0.29.3/examples/quickstart/quickstart_falkordb.py>.

## LongMemEval-S broad retrieval

The pinned cleaned LongMemEval-S runner adds 500 public conversational-memory questions
beyond the eight-question structured conformance suite. It ranks raw session transcripts as
Remembero source provenance and scores the returned session IDs against published gold
evidence. At top five, the recall-first configuration achieved 30.72% Precision@5, 83.27%
Recall@5, 80.96% MRR, and 75.32% strict all-evidence coverage over 470 answerable questions.
Local search p95 was 10.61–11.10 ms across three complete runs with zero model, embedding,
or remote calls.

This is retrieval-only, not an answer-accuracy or memory-formation result. The current
0% abstention empty rate and 43.33% preference-question Recall@5 are published gaps. The
[reproducible contract and complete result](research/LONGMEMEVAL.md) include dataset
commit/hash validation, source-window and threshold sweeps, per-question-type metrics, and
the exact evidence boundary.

The opt-in semantic policy addresses the largest measured subtype gap without changing the
default structured path. It routes explicit recommendation/advice intent through
`semantic_search_knowledge`, which reranks at most 100 locally shortlisted sources and
caches document vectors. Across all 30 preference questions, Recall@5 improved from 43.3%
to 66.7% and MRR from 23.3% to 56.8%. On the locked held-out half, Recall@5 improved from
46.7% to 53.3% and MRR from 16.1% to 45.6%. The 22 routed calls cost $0.007999824 while
recomputing every isolated corpus. Embeddings remain retrieval-only and are never used to
declare absence or proof. See the [semantic search contract](SEMANTIC-KNOWLEDGE-SEARCH.md).

## Release gates

The scorecard fails when any of these regress:

1. exact answers, answerability, retrieval precision, or citations fall below 100%;
2. stale leakage or operational errors become non-zero;
3. engine p95 exceeds 25 ms on the public suite;
4. real MCP `explain_query` exceeds 500 ms;
5. the 100,000-fact sweep exceeds parse, query, or proof budgets;
6. a scale case changes rows/proofs, skips indexing, or visits excess candidates;
7. the MCP server stops exposing required read tools;
8. the proof round trip omits the expected answer or support.
9. the separate million-fact gate changes rows/proofs, skips indexing, visits excess
   candidates, exceeds the cross-platform latency budget, or exceeds 2.5 GiB max RSS.

`npm run prepublishOnly` runs this scorecard in addition to the full tests and the original
structured-memory conformance gate.

## Evidence boundary and remaining work

This scorecard does not yet prove:

- LongMemEval answer accuracy, memory formation, or statistical superiority over another
  system; the current LongMemEval result is source retrieval only;
- repeated and memory-bounded performance beyond the current one-million-fact gate;
- managed-service availability or multi-tenant operations;
- natural-language cost stability across provider revisions and workloads beyond the
  measured recall/extraction suites;
- installation success on CPU architectures beyond the tested macOS arm64 and hosted
  Linux/Windows x64 environments;
- comparative results for managed Zep or Letta without executing pinned external adapters;
- broader LangGraph conclusions beyond the executed in-memory retrieval-only configuration.
- broader LlamaIndex conclusions beyond the executed VectorMemory retrieval-only configuration.
- broader Mem0 conclusions beyond the executed OSS/Luna/FastEmbed/Qdrant configuration.
- broader Graphiti conclusions beyond the executed OSS/Luna/FastEmbed/FalkorDBLite
  configuration.

The next gates should add cost-regression thresholds after more provider samples, scale
sweeps above one million facts, additional CPU architectures, and a pinned Letta or managed
Zep adapter.
