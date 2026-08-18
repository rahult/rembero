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

| Adapter | Answer coverage | Answer accuracy | Retrieval Recall@k | MRR | Citation recall |
|---|---:|---:|---:|---:|---:|
| Remembero engine | 100% | 100% | 100% | 100% | 100% |
| Direct fact scan | 100% | 50% | 42.9% | 42.9% | 50% |
| Lexical overlap top-k | 0% | not applicable | 85.7% | 100% | not applicable |
| Recency top-k | 0% | not applicable | 100% | 92.9% | not applicable |

These are eight questions across seven small, public cases. They are a deterministic
conformance result, not a statistically representative ranking of commercial memory
systems. The lexical and recency baselines only retrieve; assigning them zero answer
accuracy would be misleading, so answer metrics are reported as not applicable. The
versioned machine-readable snapshot is in
[`results/structured-memory-v1-summary.json`](results/structured-memory-v1-summary.json).

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
```

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
- **Graphiti/Zep:** add events as episodes with their timestamps, use hybrid search, and
  map episode provenance to event IDs. Declare whether invalidated facts are included.
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
- General superiority over Mem0, Graphiti/Zep, Letta, LangGraph, or LlamaIndex before
  those adapters are actually run.
- Production latency from the single-process diagnostic timings.
- Statistical significance from eight questions.

The next research lane is to run the same external bridges on pinned LoCoMo and cleaned
LongMemEval revisions, then connect those results to this deterministic conformance suite.
