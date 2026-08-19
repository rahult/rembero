# Remembero structured-memory benchmark

Status: v1.0.0, measured 18 August 2026 AEST

This suite compares what memory systems do after a question has been interpreted into a
precise information need. It measures answer rows, abstention, gold-evidence retrieval,
citations, rule reasoning, temporal updates, and explicit trust views independently. It
does not hide those dimensions behind one composite score.

The suite is intentionally complementary to [LoCoMo](https://aclanthology.org/2024.acl-long.747/)
and [LongMemEval](https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf).
Those benchmarks evaluate conversational memory formation, retrieval, and answer use over
long histories. This conformance suite targets contracts they do not directly test:
typed relational answers, deterministic rule chains, exact source support, tentative versus
accepted knowledge, and byte-stable replay.

## Run it

```bash
npm run bench:memory
npm run bench:memory:check
npm run bench:memory -- --json
npm run bench:memory -- --cases temporal_update,explicit_trust
```

`bench:memory:check` is a release gate: Remembero must have full answer coverage, exact
answers, correct answerability, complete citations, no stale leakage, and no operational
errors. Timings are diagnostic only; they are excluded from the semantic digest.

## Current results

| Adapter | Answer coverage | Answer accuracy | Retrieval Precision@k | Retrieval Recall@k | MRR | Citation recall |
|---|---:|---:|---:|---:|---:|---:|
| Remembero engine | 100% | 100% | 100% | 100% | 100% | 100% |
| Direct fact scan | 100% | 50% | 42.9% | 42.9% | 42.9% | 50% |
| Lexical overlap top-k | 0% | not applicable | 92.9% | 85.7% | 100% | not applicable |
| Recency top-k | 0% | not applicable | 81.4% | 100% | 92.9% | not applicable |
| LangGraph 1.2.10 + FastEmbed 0.8.0 | 0% | not applicable | 88.6% | 100% | 100% | not applicable |
| LlamaIndex VectorMemory 0.14.23 + FastEmbed 0.8.0 | 0% | not applicable | 88.6% | 100% | 100% | not applicable |
| Mem0 OSS 2.0.14 + Luna + FastEmbed 0.8.0 | 0% | not applicable | 88.6% | 100% | 100% | not applicable |
| Graphiti OSS 0.29.3 + Luna + FastEmbed 0.8.0 | 0% | not applicable | 57.1% | 44.0% | 57.1% | not applicable |

These are eight questions across seven small, public cases. They are a deterministic
conformance result, not a statistically representative ranking of commercial memory
systems. The lexical and recency baselines only retrieve; assigning them zero answer
accuracy would be misleading, so answer metrics are reported as not applicable. The
same rule applies to all four executed external adapters: they are real external memory
runs, but do not claim typed-answer or proof-citation capabilities. Remembero also achieved
100% exact answers and citations in that run. On the current Apple M4 diagnostic, Remembero's
query/proof p95 was 1.82 ms and LangGraph's local embedding ingest/search p95 was 232.66 ms;
these paths return different capability sets and the timing is not a universal product
benchmark. The external adapter excludes dependency/model initialization but includes fresh
store creation, event embedding, and search per question.

Precision@k is reported separately because the LangGraph, LlamaIndex, and Mem0 adapters
found the relevant direct fact at rank one but also returned four distractors in their top
five. Recall and MRR therefore remain 100%, while context precision is 88.6% over the seven
answerable retrieval questions. Graphiti returned precise evidence when it found any, but
missed complete evidence on several rule-oriented cases. Remembero returned only
proof-supporting events and retained 100% precision.

The versioned machine-readable snapshot is in
[`results/structured-memory-v1-summary.json`](results/structured-memory-v1-summary.json).
The pinned external result and disclosures are in
[`results/langgraph-fastembed-v1-summary.json`](results/langgraph-fastembed-v1-summary.json).
The combined two-adapter result is in
[`results/external-adapters-v1-summary.json`](results/external-adapters-v1-summary.json).
The live Mem0 formation/retrieval result is in
[`results/mem0-oss-v1-summary.json`](results/mem0-oss-v1-summary.json).
The live Graphiti formation/retrieval result is in
[`results/graphiti-oss-v1-summary.json`](results/graphiti-oss-v1-summary.json).

## Case coverage

1. Direct fact recall among 100 unrelated predicates.
2. Multi-hop rule derivation with complete supporting sources.
3. Recursive transitive reasoning.
4. Current-state selection after a temporal update.
5. Honest abstention when the requested predicate is absent.
6. Accepted-only and explicitly tentative trust views.
7. Detection of an integrity conflict from two sourced facts and a rule.

Rows contain typed cells (`atom` or `number`). Cell order is semantic, while result-row
order is not. Ground truth, no match, unsupported capability, and operational error are
distinct outcomes. The scorer deduplicates event IDs so duplicates cannot inflate
Recall@k or citation scores.

## External adapter protocol

An external adapter is one executable. The harness starts a fresh process for each case,
writes one bounded JSON request to standard input, and requires exactly one JSON object on
standard output. It never invokes a shell. Standard error is counted but suppressed so an
adapter cannot copy secrets into benchmark logs; timeouts, crashes, malformed JSON, and
oversized output fail the run.

Run a bridge:

```bash
npm run bench:memory -- --adapters remembero --external mem0=/absolute/path/to/mem0-bridge
npm run bench:memory -- --adapters remembero --external-manifest /path/to/adapter.json
```

Use `--external-manifest` for publishable comparisons. A manifest binds the adapter ID and
capabilities to package/model pins, storage and write policy, retrieval policy, provider-cost
boundary, working directory, process arguments, timeout, and output limit. The command is
still spawned directly without a shell, labels remain private, and stderr remains suppressed.

The checked-in example is reproducible with:

```bash
npm run bench:memory:langgraph
npm run bench:memory:llamaindex
npm run bench:memory:external
npm run bench:memory:mem0
npm run bench:memory:graphiti
```

It uses LangGraph's documented `InMemoryStore` semantic-search interface with a custom
embedding implementation and FastEmbed's documented 384-dimensional
`BAAI/bge-small-en-v1.5` model. The bridge is isolated under
`benchmarks/adapters/langgraph-fastembed/`; `uv` resolves its PEP 723 dependency pins and
the first run downloads the 67 MB model. No LLM or remote inference provider participates.

The LlamaIndex bridge uses `VectorMemory.from_defaults`, the default in-memory
`SimpleVectorStore`, and the official FastEmbed integration. It writes one event-tagged user
message per allowed fixture event and maps `VectorMemory.get` results back to those event IDs.
Both external adapters therefore use the same BGE model, local CPU provider, question text,
top-k, accepted/tentative policy, process isolation, and unsupported answer/citation contract.

The Mem0 bridge is intentionally separate because it exercises a different stage: native
LLM memory formation before retrieval. It pins Mem0 OSS 2.0.14, Luna via OpenRouter,
FastEmbed 0.8.0, local Qdrant, and SQLite history. Telemetry is disabled. Every allowed
event is inferred independently so its fixture source ID survives in metadata; provider
usage is captured from Mem0's native response callback. Two full runs used 118 model calls,
approximately 0.95 million tokens, cost $0.0440–$0.0445, and took 323–350 seconds p95.
This formation latency is not directly comparable to Remembero's structured-query latency;
it is published as a product-ingestion diagnostic.

The Graphiti bridge pins Graphiti OSS 0.29.3 and uses its documented `add_episode_bulk`
formation path, basic hybrid edge search, and native edge-to-episode provenance. Luna forms
the entity graph through OpenRouter; FastEmbed and embedded FalkorDBLite remain local.
The complete run achieved 57.1% Precision@k, 44.0% Recall@k, and 57.1% MRR with no
operational errors. It used 275 model calls, 411,211 tokens, cost $0.037854, and took
33.15 seconds p95. Graphiti found the direct fact among 100 distractors, but omitted rule
episodes and returned no relevant evidence for this suite's explicit trust or integrity
questions. The adapter adds no answer reader and does not treat graph facts as Datalog rules.
OpenRouter's provider-reported cost varied materially: a separate direct-case run cost
$0.096913 versus $0.029805 for the same case inside the recorded full run. Routing and cache
effects were not isolated, so reruns are required for billing decisions. Graphiti's tagged
source and FalkorDB quickstart document the pinned package and embedded-driver path:
<https://github.com/getzep/graphiti/tree/v0.29.3>,
<https://github.com/getzep/graphiti/blob/v0.29.3/examples/quickstart/quickstart_falkordb.py>.

The request is:

```json
{
  "protocolVersion": "rembero.memory-stack.v1",
  "case": {
    "id": "multi_hop_rule",
    "tags": ["derived", "multi-hop", "provenance"],
    "events": [
      {
        "id": "atlas-owner",
        "at": "2026-05-01T09:00:00.000Z",
        "text": "Rahul owns Atlas.",
        "clauses": "project_owner(atlas, rahul).",
        "trust": "accepted"
      }
    ],
    "questions": [
      {
        "id": "atlas-collaborator-question",
        "text": "Who is collaborating on Atlas?",
        "query": "collaborator(Person, atlas)",
        "answerColumns": ["Person"]
      }
    ]
  }
}
```

The response is:

```json
{
  "caseId": "multi_hop_rule",
  "questions": [
    {
      "questionId": "atlas-collaborator-question",
      "status": "answered",
      "answerRows": [[{"type": "atom", "value": "maya"}]],
      "retrieved": [
        {"eventId": "atlas-owner", "rank": 1},
        {"eventId": "atlas-contributor", "rank": 2},
        {"eventId": "collaborator-rule", "rank": 3}
      ],
      "citations": ["atlas-owner", "atlas-contributor", "collaborator-rule"],
      "wallMs": 12.5
    }
  ]
}
```

An adapter must return `unsupported` for a dimension it does not implement. A retrieval
framework can therefore compete on Recall@k and MRR without pretending to be a reasoning
or citation system.

## Mapping other stacks

The protocol deliberately avoids requiring any vendor package in Remembero:

- **Mem0:** add each event as a memory, search with the question, map returned memory IDs
  to event IDs, and return answer rows only if the bridge also runs a disclosed reader.
- **Graphiti/Zep:** the checked-in OSS adapter adds events as timestamped episodes, uses
  hybrid edge search, and maps native episode provenance to event IDs. Managed Zep remains
  a distinct, unexecuted product boundary.
- **Letta:** place event text in memory blocks or archival memory, then record which blocks
  or passages were surfaced to the agent.
- **LangGraph:** store namespaced event documents, optionally enable semantic search, and
  map `Store` result keys to event IDs. Application-provided extraction and correction
  logic must be disclosed because LangGraph does not prescribe it.
- **LlamaIndex:** use the current `Memory` API and disclose the active memory blocks,
  embedding model, vector store, token budget, and truncation policy.

For any published comparison, record package version, model and embedding identifiers,
prompts, top-k, dataset digest, hardware/region, and raw per-question outputs. Managed and
open-source variants must be treated as different adapters.

## What this benchmark cannot establish

- Natural-language extraction quality or conversational answer fluency.
- Performance over million-token histories.
- General superiority over managed Zep or Letta before those adapters are actually run.
- General answer-system superiority over LangGraph; the executed LangGraph adapter measures
  its retrieval store only and deliberately declares answers, rules, and citations unsupported.
- General answer-system superiority over LlamaIndex; the executed VectorMemory adapter has
  the same retrieval-only boundary.
- General answer-system superiority over Mem0; the executed adapter measures native memory
  formation and retrieval but deliberately adds no downstream answer reader.
- General answer-system superiority over Graphiti; the executed adapter measures native
  graph formation and retrieval but deliberately adds no downstream answer reader.
- Production latency from the single-process diagnostic timings.
- Statistical significance from eight questions.

The next research lane is to run the same external bridges on pinned LoCoMo and cleaned
LongMemEval revisions, then connect those results to this deterministic conformance suite.
