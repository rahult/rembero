# Agent memory has an evidence problem

## Retrieval is useful. A memory your agent can act on needs to show why an answer follows.

*By Rahul Trikha · Draft for Medium · 18 August 2026*

“Agent memory” has become a category. The products are no longer just chat buffers. Mem0
extracts and retrieves memories through several signals. Zep’s Graphiti represents changing
facts in a temporal knowledge graph. Letta gives agents editable memory blocks and archival
memory. LangGraph provides persistent stores across threads. LlamaIndex combines short-term
history with pluggable long-term memory blocks.

This is real progress. It also hides a basic question:

> When a memory system returns an answer, what exactly makes that answer safe to believe?

Most benchmarks measure whether the right information was found or whether a model judge
liked the final response. Those are important tests. They are not the same as proving that
an answer follows from recorded facts and reviewed rules.

That distinction is why I built Rembero, a logic-based memory layer for agents, and why I
have now published a benchmark that tries to measure the difference without turning it
into a marketing trick.

## The benchmark landscape is better than it looks

Two public datasets anchor serious work on long-term conversational memory.

[LoCoMo](https://aclanthology.org/2024.acl-long.747/) evaluates very long conversations
across single-hop, multi-hop, temporal, open-domain, and adversarial questions. The current
ACL release contains ten conversations, each averaging roughly 600 turns and 16,000 tokens.

[LongMemEval](https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf)
pushes further on sustained interaction. Its 500 questions test information extraction,
multi-session reasoning, temporal reasoning, knowledge updates, and abstention. The paper
also gives us a useful systems model: memory has an indexing stage, a retrieval stage, and
a reading stage.

That decomposition matters. If the final answer is wrong, we should be able to say whether:

- the system stored the wrong memory;
- it failed to retrieve the right evidence;
- the reader misused good evidence; or
- the question was unsupported and the system should have abstained.

The newer Mem0 benchmark repository follows a similar ingest → search → evaluate pipeline
and publishes per-question outputs. Mem0’s current documentation also warns that a high
score can be bought with larger retrieval budgets and frontier models, which is exactly
the kind of methodological honesty this category needs.

## But retrieval quality is not proof quality

Suppose the memory contains these statements:

```text
Rahul owns Atlas.
Maya contributes to Atlas.
```

And the organization has reviewed this rule:

```text
A contributor is a collaborator when someone else owns the project.
```

A vector retriever may surface both statements for “Who is collaborating on Atlas?” A
language model may then answer “Maya.” That can be a good answer. But the system still has
several independent obligations:

1. Did it apply the intended rule?
2. Did it bind the owner and contributor roles correctly?
3. Can it identify every base fact used by the derivation?
4. Would another run over the same snapshot produce the same answer and support chain?
5. If the contributor fact were tentative, should ordinary recall have used it at all?

LLM faithfulness metrics can estimate whether generated text is supported by supplied
context. The [RAGAS paper](https://aclanthology.org/2024.eacl-demo.16/) helped make
faithfulness, answer relevance, and context relevance explicit. But an evaluator model is
still a probabilistic judge. It does not establish the same property as a deterministic
derivation over a fixed knowledge snapshot.

## A scorecard, not a single score

The first Rembero structured-memory suite reports separate tracks:

- exact typed answer rows;
- answerability and abstention;
- gold-evidence Recall@k and mean reciprocal rank;
- citation precision and recall;
- rule and recursive reasoning;
- temporal updates;
- accepted versus tentative trust views; and
- operational errors and deterministic replay.

The suite has seven public cases and eight questions. It includes direct recall among 100
distractor predicates, a multi-hop rule, recursive ancestry, a current-employer update,
an unknown gift preference, two trust views, and an account-status conflict.

It is small on purpose. This is a conformance suite: each case isolates one contract and
has an exact expected result. It complements LoCoMo and LongMemEval; it does not replace
them.

Here is the first checked-in result:

| Adapter | Answer coverage | Answer accuracy | Retrieval Recall@k | MRR | Citation recall |
|---|---:|---:|---:|---:|---:|
| Rembero engine | 100% | 100% | 100% | 100% | 100% |
| Direct fact scan | 100% | 50% | 42.9% | 42.9% | 50% |
| Lexical overlap top-k | 0% | not applicable | 85.7% | 100% | not applicable |
| Recency top-k | 0% | not applicable | 100% | 92.9% | not applicable |

There are two important non-claims in that table.

First, the retrieval-only baselines are not assigned zero answer accuracy. They do not
produce answers, so the metric is not applicable. Treating “unsupported capability” as
“wrong answer” would make the chart look better while making the science worse.

Second, this is not yet a measured claim that Rembero beats Mem0, Graphiti, Letta,
LangGraph, or LlamaIndex. No external vendor adapter was executed in this snapshot. The
suite now includes an isolated JSON adapter protocol so those runs can be added without
bringing vendor dependencies or secrets into Rembero itself.

## What the first result actually shows

The direct-fact baseline succeeds when the requested relation is explicitly stored. It
fails when an answer requires a rule, recursion, current-state selection, or conflict
detection. That is expected: it was designed to expose exactly where lookup stops and
reasoning begins.

The lexical and recency baselines retrieve much of the relevant evidence. They still do
not tell us whether the evidence entails an answer. This is the key product distinction I
want Rembero to earn: retrieval helps an agent find context; proof-carrying memory tells an
agent what the selected knowledge snapshot supports.

In the Rembero lane, the same engine that returns the answer returns the proof. A derived
answer names its authored rule and recursively includes the base facts used. A missing
answer stays a no-match. Tentative facts remain outside ordinary recall unless the caller
explicitly selects the tentative view.

The run is also content-addressed. Durations and timestamps are excluded from the semantic
digest, so two deterministic replays can be compared even when the machine gets faster or
slower.

## How the other stacks fit

The major systems are not interchangeable, and a fair comparison should say what each one
actually provides.

[Mem0’s 2025 paper](https://arxiv.org/abs/2504.19413) reports LoCoMo gains and lower
latency/token use than full-context baselines. Its current managed platform has evolved
beyond the paper and publishes newer LoCoMo, LongMemEval, and large-context BEAM results.
Managed and open-source Mem0 therefore need separate adapter labels.

[Zep’s Graphiti paper](https://arxiv.org/abs/2501.13956) describes a bi-temporal knowledge
graph with episode provenance and incremental invalidation. That makes it especially
interesting for the temporal and source tracks, though its extraction, entity resolution,
and contradiction handling are model-mediated and should be measured as such.

[MemGPT](https://arxiv.org/abs/2310.08560), the research lineage behind Letta, frames
memory as virtual context managed by an agent. Current Letta memory blocks and archival
memory are therefore as much about memory-management policy as retrieval quality.

[LangGraph](https://docs.langchain.com/oss/python/langgraph/add-memory) provides
thread-scoped checkpoints and cross-thread stores; it deliberately leaves extraction,
deduplication, correction, and provenance to the application. A benchmark should not
attribute application logic to the framework.

[LlamaIndex Memory](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/)
supports FIFO short-term history plus static, fact-extraction, and vector memory blocks.
Results depend on the selected blocks, models, vector store, token budget, and truncation
policy, all of which must travel with the score.

## The publication standard I want

For every public memory comparison, I want to see:

- the exact dataset revision and digest;
- raw per-question outputs;
- separate ingest, retrieval, reader, and abstention metrics;
- model, embedding, prompt, top-k, and temperature settings;
- managed versus open-source product labels;
- complete source or citation IDs;
- p50 and p95 latency with disclosed hardware and region; and
- repeated-run variance for any model-judged measure.

Most importantly, I want “the system retrieved relevant text” and “the answer is entailed”
to remain different claims.

Rembero’s first suite is not large enough to settle the agent-memory market. It is large
enough to make our own standard falsifiable. The next milestone is to run pinned external
adapters on this conformance suite and on cleaned LongMemEval, then publish the complete
artifacts whether the results flatter Rembero or not.

That is the point of proof-carrying memory: the answer should not get special treatment
because it is ours.

---

**Disclosure:** Rahul Trikha is the creator of Rembero. The benchmark and article are
vendor-authored. Current results cover Rembero and transparent local baselines only. No
external commercial system was measured in this snapshot.

**Suggested Medium tags:** Artificial Intelligence, AI Agents, Databases, Open Source,
Retrieval-Augmented Generation
