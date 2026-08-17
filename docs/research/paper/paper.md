---
title: "Proof-Carrying Agent Memory: A Deterministic Conformance Suite for Answers, Evidence, Updates, and Trust"
author: "Rahul Trikha"
date: "18 August 2026"
bibliography: references.bib
link-citations: true
abstract: |
  Agent-memory evaluations commonly combine memory formation, retrieval, and language-model reading into a single answer score. This makes failures difficult to localize and does not test whether an answer is deterministically supported by the selected memory snapshot. We introduce the Rembero Structured-Memory Conformance Suite, a small public benchmark that reports exact typed answers, answerability, gold-evidence retrieval, citations, temporal updates, trust views, and deterministic replay as separate dimensions. The v1 suite contains seven cases and eight questions spanning direct recall among distractors, multi-hop and recursive rules, a knowledge update, abstention, tentative knowledge, and conflict detection. We evaluate Rembero and three transparent baselines. Rembero attains 100% exact answer accuracy and citation recall on the suite; a direct-fact baseline attains 50% answer accuracy, while lexical and recency baselines are evaluated only on retrieval. These preliminary results establish conformance, not statistical superiority over external memory systems. We contribute an isolated JSON adapter protocol for future Mem0, Graphiti/Zep, Letta, LangGraph, and LlamaIndex runs, and position the suite as a complement to LoCoMo and LongMemEval rather than a replacement.
---

# 1. Introduction

Long-lived language-model agents need information beyond a single context window. Current
systems address this need with extracted facts, vector retrieval, graph representations,
persistent stores, editable memory blocks, and increasingly explicit temporal metadata.
The resulting “agent memory” category spans complete products such as Mem0 and Zep,
agent-managed context systems such as Letta/MemGPT, and framework primitives in LangGraph
and LlamaIndex [@mem02025; @zep2025; @memgpt2023; @langgraphmemory2026;
@llamaindexmemory2026].

Existing evaluation has advanced quickly. LoCoMo measures question answering and other
tasks over multi-session conversations [@locomo2024]. LongMemEval evaluates information
extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention,
and usefully separates indexing, retrieval, and reading [@longmemeval2025]. RAGAS proposes
automated measures for faithfulness, answer relevance, and context relevance
[@ragas2024]. Static retrieval benchmarks such as BEIR and MTEB provide mature retrieval
and embedding metrics [@beir2021; @mteb2022].

These benchmarks do not directly test a different contract: given an immutable structured
knowledge snapshot and a precise query, does the system return the exact answer supported
by that snapshot, identify the complete source support, honor trust boundaries, and
produce the same semantic result when replayed?

This paper introduces a deterministic structured-memory conformance suite for that
contract. It makes four contributions:

1. a versioned public case and label format with typed, ordered answer cells;
2. separate scores for answers, answerability, retrieval, citations, and stale evidence;
3. transparent direct-fact, lexical, and recency baselines; and
4. an isolated JSON process protocol for evaluating external stacks without coupling the
   benchmark package to their dependencies or credentials.

The contribution is deliberately narrow. The suite evaluates downstream structured
memory after question interpretation. It does not evaluate natural-language extraction,
free-form generation, or million-token scalability. The reported results therefore
establish deterministic conformance on the published cases, not general market
superiority.

# 2. Related work

## 2.1 Conversational memory benchmarks

LoCoMo's current ACL release contains ten long conversations, averaging approximately 600
turns and 16,000 tokens over as many as 32 sessions. Its question-answering task covers
single-hop, multi-hop, temporal, open-domain/world-knowledge, and adversarial questions
[@locomo2024]. The conversations were generated through an agent pipeline and human-edited
for consistency. This provides controlled long-range dependencies, but it is not a sample
of organic production histories.

LongMemEval contains 500 human-curated questions embedded in scalable user-assistant
histories. Its core abilities are information extraction, multi-session reasoning,
temporal reasoning, knowledge updates, and abstention [@longmemeval2025]. Standard settings
include an approximately 115,000-token history and a 500-session, approximately 1.5
million-token history. The benchmark reports answer accuracy and gold-evidence retrieval,
making it suitable for separating retriever and reader failures.

Our suite borrows both the capability taxonomy and the separation of retrieval from answer
use. It adds deterministic rule entailment, explicit proof sources, typed answers, trust
views, and semantic replay. Conversely, it does not reproduce the scale or linguistic
variability of either benchmark.

## 2.2 Retrieval and answer attribution

BEIR evaluates heterogeneous zero-shot retrieval using measures including nDCG, MAP,
Recall@k, precision, and MRR [@beir2021]. MTEB broadens embedding evaluation across
retrieval, reranking, clustering, classification, semantic similarity, and related tasks
[@mteb2022]. These benchmarks are appropriate for retrieval components but do not evaluate
memory formation, temporal correction, or deductive answer support.

RAGAS introduced reference-free, model-based measures of RAG faithfulness and relevance
[@ragas2024]. Such measures are valuable when answers and sources are natural language.
They remain estimates produced by an evaluator model. In the present suite, answer and
source correctness are mechanically decidable, so probabilistic judging is unnecessary.

## 2.3 Agent-memory systems

Mem0 extracts, consolidates, and retrieves salient conversational information; its 2025
paper evaluates multiple configurations and baselines on LoCoMo [@mem02025]. Graphiti/Zep
represents episodes, entities, and bi-temporal facts in an incrementally updated temporal
knowledge graph [@zep2025]. MemGPT frames long-term agent state as a virtual-context
management problem with working, recall, and archival tiers [@memgpt2023]. LangGraph
provides thread checkpoints and cross-thread stores while leaving memory semantics to the
application [@langgraphmemory2026]. LlamaIndex provides FIFO short-term history and
pluggable static, fact-extraction, and vector memory blocks [@llamaindexmemory2026].

These differences make a single aggregate leaderboard inappropriate. An adapter must
declare whether it produces answers, ranked retrieval, citations, rule reasoning, temporal
updates, and trust views. Unsupported capabilities remain unscored rather than silently
receiving zero or full credit.

# 3. Benchmark design

## 3.1 Scope and unit of evaluation

Each case contains timestamped events and one or more questions. An event has a stable ID,
human-readable text, canonical Datalog clauses, and an accepted or tentative trust label.
A question has a stable ID, natural-language text, a canonical query, explicit ordered
answer columns, a trust-view selection, and an optional retrieval cutoff.

The canonical query is part of the public input. This design intentionally removes
question translation from the measured system. External adapters may use the natural
question for retrieval and the query for structured execution. Results must disclose which
representation was used.

Private labels are withheld from the adapter request. A label specifies expected status,
typed answer rows, gold event IDs, and optionally stale event IDs. Fixture and label
collections are content-addressed with canonical JSON and SHA-256.

## 3.2 Cases

Version 1.0.0 contains seven cases and eight questions:

| Case | Contract under test |
|---|---|
| Direct fact at scale | Exact recall among 100 unrelated predicates |
| Multi-hop rule | Derived answer with two base facts and an authored rule |
| Recursive reasoning | Transitive closure over a three-edge parent chain |
| Temporal update | Current value selected from two revisions with an aggregate rule |
| Honest abstention | No answer for an absent predicate |
| Explicit trust | Accepted-only and accepted-plus-tentative views |
| Integrity conflict | Conflict derived from two incompatible statuses |

This diagnostic composition over-represents deductive capabilities by design. Scores must
not be interpreted as expected production query frequencies.

## 3.3 Typed answers and status semantics

An answer row is an ordered array of typed cells. A cell is either an atom string or a
finite number. Result-row order is ignored, but cell order is preserved. Consequently,
`[parent, child]` is not equal to `[child, parent]`, and the atom `"1"` is not equal to the
number `1`.

The protocol distinguishes `answered`, `no_match`, `unsupported`, and `error`. This avoids
three common evaluation errors: treating a structurally unsupported capability as an
incorrect answer, confusing an empty result with an operational failure, and counting an
unsupported adapter as a correct abstention.

## 3.4 Metrics

For expected row set $E$ and returned row set $A$, answer precision and recall are

$$P_a = \frac{|A \cap E|}{|A|}, \qquad R_a = \frac{|A \cap E|}{|E|}.$$

Exact-answer accuracy additionally requires the correct status and set equality. Empty-set
precision and recall are defined as one only when both sets are empty.

For gold evidence event set $G$ and the top-$k$ retrieved event IDs $D_k$, retrieval recall
is

$$R@k = \frac{|D_k \cap G|}{|G|}.$$

Mean reciprocal rank uses the rank of the first gold event. Questions without relevant
events, such as the abstention case, are excluded from retrieval aggregates. Citation
precision and recall apply the same set equations to explicit citation IDs. Duplicate IDs
are removed before scoring.

Capability coverage is reported with every metric. Timing is reported diagnostically but
excluded from semantic digests. A release check requires a full-coverage Rembero run with
exact answers, exact answerability, complete citations, no stale leakage, and zero
operational errors.

## 3.5 External adapter isolation

The harness launches one process per case, without a shell, passes one bounded JSON request
on standard input, and requires one JSON response on standard output. It enforces time and
output limits, kills failed children, suppresses standard-error contents, and passes only
a small environment allowlist plus explicit adapter configuration. This provides state isolation and prevents vendor packages
from becoming Rembero runtime dependencies.

# 4. Systems and baselines

**Rembero engine.** Accepted clauses, plus tentative clauses only when selected, are parsed
and evaluated by the same bounded Datalog engine used by the product [@rembero2026]. Answer
rows come from explicit variables. Citation event IDs are recovered recursively from base
facts, rule identifiers, and aggregate contributors in the deterministic proof.

**Direct fact scan.** The same parser and evaluator receive ground facts only; all rules
are removed. This isolates the value of deductive and temporal computation while retaining
identical typed-query and trust-view mechanics.

**Lexical overlap top-k.** Events are ranked by deterministic normalized token overlap
with the natural-language question, with event ID as the tie-breaker. It does not produce
answers or citations.

**Recency top-k.** Events are ranked by descending timestamp with stable event-ID
tie-breaking. It does not produce answers or citations.

No Mem0, Graphiti/Zep, Letta, LangGraph, or LlamaIndex adapter was executed in this first
snapshot. The protocol supports such runs, but reporting unexecuted values would defeat the
purpose of the benchmark.

# 5. Results

The suite digest is
`2a483f29d0123bea651a8f4a7eec0a7b5193e58667474b5e96bbe8319c131524`.
Table 2 reports the checked-in 18 August 2026 run.

| Adapter | Answer coverage | Exact answer | Retrieval R@k | MRR | Citation recall | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Rembero engine | 100% | 100% | 100% | 100% | 100% | 0 |
| Direct fact scan | 100% | 50% | 42.9% | 42.9% | 50% | 0 |
| Lexical overlap top-k | 0% | N/A | 85.7% | 100% | N/A | 0 |
| Recency top-k | 0% | N/A | 100% | 92.9% | N/A | 0 |

Rembero returned the exact expected typed rows and complete source-event set for every
question. Three repeated deterministic runs in the automated test produced an identical
semantic digest; wall-clock duration is intentionally excluded from that digest.

The direct-fact baseline answered the cases whose requested relations were explicitly
stored and failed on rule-dependent, recursive, temporal, and conflict-derived outputs.
The lexical and recency baselines retrieved substantial evidence but were not evaluated on
answers. This is not a flaw in those adapters; it is an explicit boundary of their declared
capabilities.

# 6. Discussion

The result demonstrates that deterministic proof-carrying memory can satisfy a set of
contracts that retrieval metrics alone cannot express. In particular, the same execution
that produces a derived answer produces the source support; no post-hoc model is asked to
guess which retrieved text justifies the answer.

The suite also illustrates why capability coverage must accompany accuracy. Reporting
zero answer accuracy for retrieval-only baselines would imply that they attempted and
failed to answer. Reporting 100% abstention accuracy would reward them for never answering.
The correct value is not applicable.

Finally, a complete proof may legitimately cite older temporal facts because those facts
participate in establishing which revision is greatest. “Old evidence appeared in the
proof” is therefore not equivalent to “the system leaked a stale answer.” Temporal
benchmarks should distinguish evidence needed to establish an update from obsolete values
incorrectly returned as current.

# 7. Threats to validity

**Scale.** Eight questions cannot estimate real-world accuracy or support significance
tests. The suite is a release conformance gate.

**Task composition.** The cases were designed by the Rembero author around Rembero's
contracts. This creates obvious vendor bias. External benchmark results must be reported
alongside LoCoMo and LongMemEval, and future cases should accept independent contributions.

**Structured input advantage.** Rembero receives canonical clauses and queries. This
removes its natural-language extraction and translation failure modes. The suite measures
the structured memory layer, not the complete user experience.

**Baseline strength.** Direct, lexical, and recency baselines are transparent controls,
not state-of-the-art competitors. No external-stack superiority claim follows.

**Latency.** The checked-in run uses a single local repetition. Timings are diagnostic and
must not be compared with published vendor latency.

**Proof completeness definition.** Gold evidence is specified at event granularity. A
production source may contain several claims or several source spans, requiring finer
attribution labels.

# 8. Reproducibility and future work

All fixtures, labels, scorers, adapters, tests, and the versioned result summary are stored
with Rembero [@rembero2026]. The release command builds the project before executing the
suite. The semantic result excludes generated timestamps and timings.

Immediate future work is:

1. implement and independently review adapters for Mem0, Graphiti/Zep, Letta, LangGraph,
   and LlamaIndex;
2. pin and run the cleaned LongMemEval dataset and current LoCoMo release through the same
   adapter disclosures;
3. add natural-language formation as a separate track with signed mutation precision and
   recall;
4. add recorded-time versus valid-time, out-of-order updates, deletion, and alternative
   proof cases;
5. repeat performance measurements under disclosed hardware, models, regions, concurrency,
   and retrieval budgets; and
6. invite external case authors and preregister thresholds before expanding the suite.

# 9. Conclusion

Agent memory should be evaluated as a pipeline, not a single answer score. Retrieval,
answer use, temporal behavior, abstention, citations, and deterministic proof are related
but distinct properties. The Rembero Structured-Memory Conformance Suite makes those
properties explicit and provides a reproducible process boundary for other systems.

The first result is intentionally modest: Rembero conforms to eight published structured
memory questions; simple controls expose where direct lookup and retrieval stop. The work
does not yet establish superiority over external stacks. Its purpose is to make the next
comparison inspectable enough that a reader can tell exactly what was measured, what was
not measured, and why every reported answer received its score.

# Disclosure

The author is the creator of Rembero. The suite and paper are vendor-authored. The current
snapshot contains measured Rembero and transparent baseline results only.

# References

::: {#refs}
:::
