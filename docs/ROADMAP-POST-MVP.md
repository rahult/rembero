# Rembero post-MVP roadmap (v0.10 →)

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

## Phase 9 — Retrieval quality at scale  *(v0.7)*

Schema summaries stop fitting in a prompt somewhere around ~100 predicates:

1. **Complete — deterministic schema pruning for recall**: a local lexical ranker sends a
   bounded detailed slice plus a compact predicate catalog, retains transitive rule
   dependencies and temporal companions, and chooses question-matching samples. Accepted
   queries still evaluate over the full allowed clause set. Partial negative results widen
   once or return `schema_budget_exhausted`; they never become false “no memory” claims.
2. **Complete — scale-aware eval harness**: the checked-in labeled recall corpus now runs
   among 100 deterministic distractor predicates, reports precision/recall/F1,
   answerability, and schema-budget exhaustion, and retains prompt/model comparisons plus
   deterministic metric tests. A credentialed nightly CI run remains optional ecosystem
   work.
3. **Model flexibility**: verify the pipeline against 2-3 other OpenRouter models;
   document which work well as cheaper `LLM_MODEL` choices.

## Phase 10 — Ecosystem  *(ongoing)*

- Setup guides for other MCP clients (Cursor, Windsurf, Claude Desktop).
- Library API docs (typedoc) — the engine is a legitimate standalone Datalog package.
- Issue templates, CONTRIBUTING.md, dependabot, coverage reporting.
- Demo GIF / asciinema in README; a blog-style walkthrough of the design.

## Phase 11 — Evidence diversity  *(v0.8)*

1. **Complete — bounded alternative-proof inspection**: relational explain surfaces can
   enumerate deterministic branch-simple derivations without changing the ordinary
   semi-naive fixpoint or first-witness default. Structural duplicates collapse, proof
   count/search/depth/node/output limits fail closed, and aggregate completeness remains
   separate.
2. **Complete — corroborating source witnesses**: an asserted claim keeps its existing
   first namespace source while expanded inspection exposes the remaining ordered active
   sources as `sourceAlternatives`.
3. **Complete — proof-instance graph projection**: expanded graphs add ephemeral `proof`
   nodes and `proves` edges so two derivations of one grounded claim remain distinct
   without materializing a second graph store.

## Phase 12 — Knowledge integrity  *(v0.9)*

1. **Complete — explicit headless constraints**: portable programs can declare forbidden
   states as `:- goals.` without guessing functional or mutually exclusive semantics from
   predicate names. Constraints are range-restricted, alpha-deduplicated, journaled, and
   inert during ordinary evaluation, stratification, recall, and rule numbering.
2. **Complete — deterministic integrity inspection**: library `checkIntegrity`, CLI
   `check`, and MCP `check_integrity` evaluate the selected current namespace union and
   return complete bounded violation rows with proofs, durable sources, and query-scoped
   graphs. Archived facts participate only when a policy names `_until` explicitly.
3. **Complete — policy trust boundary**: raw local Datalog can declare constraints, while
   natural-language remember and ambient capture are forbidden from creating policy.
   v0.9 is read-only audit; atomic reject-on-write enforcement remains a later milestone.

## Phase 13 — Integrity authority  *(v0.10)*

1. **Complete — atomic candidate enforcement**: opt-in `strict` and
   `no_new_violations` modes validate the entire post-mutation knowledge view before any
   `.dl`, mutation-journal, or cache commit. Rejections reuse the bounded deterministic
   proof, source, and query-scoped graph evidence from the 0.9 audit.
2. **Complete — concurrent and cross-namespace safety**: every supported portable-store
   writer participates in one cross-process mutation lock, so constraints joining an
   explicit namespace union cannot race another 0.10 writer. The target namespace must
   be inside the governed view.
3. **Complete — complete write-path coverage**: raw assert/import, forget, archive
   supersession, atomic delete-and-replace remember, ambient capture, MCP writes, and
   single-namespace reviewed-fact pruning share the same enforcement boundary. LLM paths
   still cannot author policy, and audit remains the backward-compatible default.

## Phase 14 — Explicit entity identity  *(v0.11)*

1. **Complete — position-scoped canonical view**: raw alias and entity-position facts
   opt selected predicate arguments into deterministic chain resolution. Literal reads,
   durable writes, and history remain unchanged by default.
2. **Complete — proof-carrying recall and graph projection**: query generation is
   canonicalized after validation, projected claims retain their exact literal source,
   and query-scoped entity nodes expose alias provenance without a second graph store.
3. **Complete — integrity and interface coverage**: audit and atomic enforcement can opt
   into the same view across library, CLI, and MCP. Natural-language writers cannot
   author identity metadata, invalid canonical views fail closed, and SQLite rejects the
   feature until parity exists.

## Phase 15 — Query-scoped graph navigation  *(v0.12)*

1. **Complete — result and support closures**: library, CLI, and MCP callers can select
   one result's complete support or navigate from a known graph node while rows, proofs,
   rules, and stored facts remain unchanged.
2. **Complete — bounded neighborhoods**: deterministic undirected breadth-first slices
   are capped at depth 8, reject unknown or oversized node IDs, and preserve source graph
   ordering.
3. **Complete — integrity and recall coverage**: recall explanations, integrity audits,
   and atomic write rejections expose the same selector and selection metadata without a
   graph sidecar.

## Phase 16 — Retry-safe raw writes  *(v0.13)*

1. **Complete — durable assertion and retraction replay**: explicit operation IDs are
   resolved under the existing mutation, namespace, and journal locks. Matching retries
   return the first result, including original added/duplicate/removed counts, without a
   second mutation or journal entry.
2. **Complete — deterministic conflicts and no-ops**: normalized request mismatch raises
   typed `OperationConflictError`; explicit no-op writes record one bounded replay marker
   while unchanged implicit no-ops remain unjournaled.
3. **Complete — public ingress and cross-process proof**: library, CLI assert/forget/import,
   and MCP assert/forget accept bounded IDs. Concurrent process retries collapse to one
   durable operation, and CLI/MCP expose stable machine-readable conflicts.

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

The next reasoning milestone remains an evidence-driven index pass once benchmarks show
relation scans becoming material. Retrieval context, alternative evidence, explicit
identity projection, integrity audits, and enforced candidate writes are bounded independently of
knowledge-base growth while the finite, proof-carrying rule language remains the
deterministic authority. Direct hand edits and older writers remain outside the lock and
must be followed by an explicit audit.
