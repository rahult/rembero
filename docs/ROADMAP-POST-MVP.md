# Rembero post-MVP roadmap (v0.6 →)

MVP shipped: public repo, CI, GitHub release v0.1.0, npm package ready (publish pending
auth). What follows is ordered by user value per unit of effort — each phase is
independently shippable as a minor release.

## Phase 6 — Reasoning power  *(v0.2–v0.4)*

The engine's expressiveness ceiling is the first thing power users will hit.

1. **Stratified negation** (`\+ goal` in rule bodies): complete. The portable engine
   rejects negative cycles, evaluates strata bottom-up, and emits explicit absence proof
   nodes for rules such as "employees with no assigned desk".
2. **Aggregation**: complete. `count`, `min`, `max`, and `sum` are exact scalar
   query-level operators (not in rules), with a dedicated input cap, complete contributor
   proofs, and aggregate nodes in the personal knowledge graph.
3. **Arithmetic in comparisons**: complete. Both comparison operands accept bounded
   numeric expressions with `+`, `-`, `*`, `/`, unary signs, parentheses, and standard
   precedence. Arithmetic remains filter-only, so it cannot expand the finite fact
   universe; invalid numeric operations fail closed.
4. **Engine perf pass**: first-argument indexing for relations (today: linear scan per
   goal). Only matters past ~10k facts; benchmark first.

## Phase 7 — Auto-capture  *(v0.5)*

Today the agent decides when to call `remember`. Auto-capture makes memory ambient:

1. **Complete:** `rembero init-hooks` idempotently merges one safe exec-form asynchronous
   Claude Code Stop hook; removal touches only Rembero's managed entry. The hook sends
   Stop JSON on stdin to `rembero remember --batch`.
2. **Complete:** only a bounded regular transcript beneath Claude's configured projects
   root is read. Tool/thinking/code noise is removed, credential-like text fails closed,
   duplicate fingerprints and per-namespace UTC-day quotas are reserved before the LLM
   call, and extraction accepts additive ground facts only.
3. **Complete:** every capture is journaled as started/captured/empty/failed/skipped with
   stable IDs and no raw transcript copy. `rembero review` shows recent attempts and
   numbers current/removed facts; `--forget <n,...>` performs explicit journaled pruning.

## Phase 8 — Time & provenance  *(v0.6)*

"Where did Mira work *before* Initech?" is unanswerable once supersession retracts the
old fact. Fix by making time first-class:

1. **Complete — valid-time option**: `archive_until` atomically rewrites a superseded
   ground fact to `<predicate>_until(..., <ISO instant>)` in the same `.dl` file while
   adding its replacement. Deletion remains the default; `forget` stays destructive and
   auto-capture stays additive.
2. **Complete — provenance-aware temporal recall**: historical predicates participate in
   ordinary recall, deterministic proofs, and the query-scoped personal knowledge graph.
   Their sources carry the preceding clause and exact valid-until instant.
3. **Complete — `rembero history <pattern>`**: a bounded, redacted, fail-closed replay of
   one fact pattern's append-order life story across the CLI, MCP, and library APIs.

## Phase 9 — Retrieval quality at scale  *(v0.7, ~2-3 days)*

Schema summaries stop fitting in a prompt somewhere around ~100 predicates:

1. **Schema pruning for recall**: rank predicates by lexical/embedding similarity to the
   question, send only the top slice.
2. **Eval harness**: recall now has a checked-in labeled corpus, precision/recall/F1 and
   answerability metrics, prompt/model comparisons, and deterministic metric tests. Add
   extraction fixtures and a credentialed nightly CI run before v0.5.
3. **Model flexibility**: verify the pipeline against 2-3 other OpenRouter models;
   document which work well as cheaper `LLM_MODEL` choices.

## Phase 10 — Ecosystem  *(ongoing)*

- Setup guides for other MCP clients (Cursor, Windsurf, Claude Desktop).
- Library API docs (typedoc) — the engine is a legitimate standalone Datalog package.
- Issue templates, CONTRIBUTING.md, dependabot, coverage reporting.
- Demo GIF / asciinema in README; a blog-style walkthrough of the design.

## Not planned

- Hosted/multi-user service (rembero is deliberately local-first; revisit on demand)
- Full Prolog (function symbols, cut, arbitrary recursion) — the termination guarantee
  is a feature, not a limitation
- Vector similarity as the *primary* retrieval path — logic stays the source of truth

## SQLite deductive extension

V0 established a loadable C extension with `datalog_sql(rule)` and
`datalog_query(rule)`, plus a Node adapter and CLI integration. The next milestone is now
complete: multi-rule programs over ordinary SQLite tables use bounded semi-naive fixpoint
evaluation, and `datalog_explain(program)` returns one nested derivation proof per result.

The portable store now supplies source-aware valid-time history. A full bi-temporal model
remains a later, evidence-driven expansion. Vector composition should reuse existing
SQLite vector infrastructure rather than consume originality budget in this project.

## Explainable personal knowledge graph

The portable `.dl` memory path now retains deterministic first-witness proofs, stable
mutation/source IDs, and query-scoped hypergraphs across the library, CLI, and MCP. This
is the foundation for conflict views, temporal history, and alternative proof inspection
without replacing the readable personal knowledge base with a second graph store.

The next reasoning milestone is an evidence-driven index pass once benchmarks show
relation scans becoming material. Product work can now move to opt-in auto-capture while
the finite, proof-carrying rule language remains the deterministic authority.
