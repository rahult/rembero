# Semantic knowledge search

Remembero keeps structured query and proof local, deterministic, and free. For fuzzy
recommendation, preference, and advice questions, an opt-in semantic tool can rerank a
bounded lexical shortlist without making embeddings answer authority.

## Use it

```bash
export LLM_API_KEY=...
remembero semantic-search 'Can you recommend accessories for my camera setup?'
```

Agent harnesses can call `semantic_search_knowledge` over MCP. The result returns ranked
clauses, durable sources, the original lexical rank, cosine score, cache hits/misses, model,
provider tokens, and provider-reported cost.

Use this tool for recommendation/advice intent. Use `query`, `explain_query`,
`recall_explain`, or evidence answer mode when the answer must be logically established.
Similarity is retrieval evidence, never proof and never an abstention decision.

## Boundary

The semantic path:

1. runs deterministic local search first;
2. selects at most 100 candidates;
3. uses at most 16,384 source characters per candidate;
4. rejects detected secrets before any network call;
5. permits only namespaces allowed by `REMBERO_LLM_ALLOWED_NAMESPACES`;
6. sends one bounded embedding batch;
7. ranks by cosine similarity, breaking ties by lexical rank; and
8. caches document vectors by model and content hash in memory and in a bounded derived
   cache under the memory root.

The default model is `perplexity/pplx-embed-v1-0.6b` through the configured OpenAI-compatible
embedding endpoint. Override it with `REMBERO_EMBEDDING_MODEL` and the endpoint with
`REMBERO_EMBEDDING_BASE_URL`. `LLM_API_KEY` is used by default; `OPENROUTER_API_KEY` is an
accepted fallback.

The first cache layer is a 2,000-entry in-process LRU. The second is
`.semantic-embeddings/`, a restart-safe derived cache containing only vectors, content/model
hashes, and integrity metadata—never source text. Files are written atomically with `0600`
permissions in a real `0700` directory. Corrupt, oversized, symlinked, or digest-mismatched
entries become misses and are recomputed. Changing source text or model changes the key.
The directory is bounded to 2,000 entries and may be deleted at any time; the journal,
program, and provenance remain the sole authority.

## Measured preference gate

The pinned LongMemEval-S policy routes only explicit recommendation/advice intent to
semantic retrieval and leaves every other question on local lexical search. Question IDs
are split deterministically by SHA-256 before policy selection.

| Preference metric | Development lexical | Development policy | Held-out lexical | Held-out policy |
| --- | ---: | ---: | ---: | ---: |
| Precision@5 | 8.0% | 16.0% | 9.3% | 10.7% |
| Recall@5 | 40.0% | 80.0% | 46.7% | 53.3% |
| MRR | 30.6% | 68.0% | 16.1% | 45.6% |

Across all 30 preference questions, Recall@5 improves from 43.3% to 66.7% and MRR from
23.3% to 56.8%. The 22 routed requests used 1,999,956 provider tokens and cost $0.007999824,
or $0.000364 per routed question, while recomputing every candidate vector.

A live MCP restart probe over two documents measured 744 ms on the initial request and
399 ms after closing and restarting the server. Both document vectors survived as cache
hits; provider input fell from 32 to 9 tokens and charged cost from $0.000000128 to
$0.000000036. These tiny timings are a boundary check, not a production latency claim.

Run the reproducible live-provider evaluation after downloading LongMemEval-S:

```bash
npm run bench:longmemeval:download
npm run bench:longmemeval:semantic
```

The machine-readable result is
[`research/results/semantic-preference-v1-summary.json`](research/results/semantic-preference-v1-summary.json).
OpenRouter documents batching, caching, cosine comparison, model selection, and its
OpenAI-compatible embeddings endpoint:
<https://openrouter.ai/docs/api/reference/embeddings>.

## Remaining limits

- Held-out recall improved, but 53.3% still leaves meaningful preference misses.
- Cold evaluation deliberately uses isolated corpora. MCP and CLI reuse the derived disk
  cache across processes, but first access still embeds shortlisted documents.
- The cache is populated on search rather than incrementally at write time.
- A lexical miss outside the 100-candidate shortlist cannot be recovered semantically.
- Embedding-provider pricing and routing can change; rely on returned usage, not this snapshot.
- Providers can revise a model behind a stable ID; change `REMBERO_EMBEDDING_MODEL` (or clear
  `.semantic-embeddings/`) before mixing vectors from a known model revision change.
