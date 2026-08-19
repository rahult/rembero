# Deterministic local knowledge search

Remembero 0.31 searches the readable personal knowledge program without an LLM, embedding
model, vector index, or persistent search database. It is a deterministic discovery
surface for finding likely clauses and provenance before using `query` or `explain` for
logical proof.

## Use

```bash
remembero search 'Doctor Chen'
remembero search 'colleague work' --kind rule
remembero search 'active terminated' --kind constraint
remembero search 'Mira status' --as-of-sequence 17
```

The library exposes `searchKnowledge(clauses, text, sources, options)`. MCP exposes
`search_knowledge`. All paths are local and read-only.

## Fixed scoring

Every returned point is visible in `reasons`:

| Reason | Points |
|---|---:|
| exact bounded source phrase | 180 |
| exact authored-clause phrase | 160 |
| head predicate word | 120 |
| body predicate word | 70 |
| ground atom/number word | 60 |
| durable source word | 45 |
| authored clause word | 20 |
| predicate edit distance at most one | 30 |

Words use the same lowercase, camel/symbol splitting, and small deterministic morphology
normalization as recall schema ranking. Common English conversational stopwords are removed
before scoring so question framing such as “what did I” does not promote unrelated source
text. Each reason/token pair scores once. Results sort by score descending, then fact, rule,
constraint, then canonical clause text. There is no learning, frequency feedback,
personalization weight, or hidden relevance state.

Fuzzy matching is predicate-only, requires words of 4–64 characters, and never changes
the clause or query. `collegue` can discover `colleague`; it is not treated as proof that
the predicates mean the same thing.

## Result and graph contract

Each result includes rank, kind, canonical clause, total score, exact reasons, referenced
predicate signatures, complete durable sources, tentative trust label when opted in, and
whether source text used for ranking was truncated.

The separate graph connects:

- one search node to ranked result nodes;
- each result to its clause;
- rule clauses to defined and body predicates with authored body positions; and
- ground fact heads to entity nodes.

Recursive rules retain both `defines` and `depends_on` edges even when both target the same
predicate. The graph is retrieval evidence only and does not replace query-scoped proof
graphs.

## Sources, identity, trust, and history

Durable source text is already credential-redacted by the store. Ranking reads 16,384
source characters across a clause's sources by default, accepts an explicit library-level
`sourceCharacterLimit` from 1 to 32,768, and marks `rankingSourceTruncated` when more exists;
returned provenance remains complete. A single search considers at most 32 MiB of aggregate
source text, reducing the effective per-clause window when needed. The result reports the
requested and effective limits. Source text never leaves the process.

Canonical identity and `include_tentative` are projected before indexing, exactly as on
reasoning paths. Reserved metadata is hidden. Tentative clauses remain absent by default
and are explicitly labelled when included. Recorded search uses the exact journal
sequence and provenance from that state.

## Bounds and honesty

Defaults and limits are 20 returned results, maximum 100; 100,000 candidate clauses;
64 KiB and 256 distinct normalized search words; existing 32-namespace and
recorded-history limits; and the 16 MiB
CLI/MCP output boundary. Kind filters may include fact, rule, and/or constraint. An empty
filter, non-searchable punctuation-only text, invalid kind, or out-of-range limit fails
explicitly.

Library callers may set `minimumScore` from 1 to 10,000. The default 1 is recall-first;
higher values make `no_match` more selective. This knob is intentionally not model-authored
in the MCP tool schema: a trusted harness chooses retrieval policy, while the model supplies
only the search text and bounded result count.

`status: "no_match"` means no selected clause earned a lexical score. It does not mean no
fact follows logically or no semantically related knowledge exists. Use natural recall
for model-assisted query translation, or raw `query`, `explain`, and `why-not` for
deterministic logical conclusions.

For paraphrased preference, recommendation, or advice retrieval, use the opt-in
[`semantic-search` / `semantic_search_knowledge` path](SEMANTIC-KNOWLEDGE-SEARCH.md). It
reranks this local search's bounded shortlist and remains retrieval evidence rather than
logical proof.
