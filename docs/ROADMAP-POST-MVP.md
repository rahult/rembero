# Rembero post-MVP roadmap (v0.10 →)

MVP shipped: public repo, CI, GitHub release v0.1.0, npm package ready (publish pending
auth). What follows is ordered by user value per unit of effort — each phase is
independently shippable as a minor release.

## Phase 6 — Reasoning power  *(v0.2–v0.4)*

The engine's expressiveness ceiling is the first thing power users will hit.

1. **Stratified negation** (`\+ goal` in rule bodies): complete. The portable engine
   rejects negative cycles, evaluates strata bottom-up, and emits explicit absence proof
   nodes for rules such as "employees with no assigned desk".
2. **Aggregation**: complete. `count`, `min`, `max`, and `sum` began as exact scalar
   query operators with dedicated input caps and contributor graphs; v0.20 also permits
   one strictly stratified grouped reduction to define a reusable rule predicate.
3. **Arithmetic in comparisons**: complete. Both comparison operands accept bounded
   numeric expressions with `+`, `-`, `*`, `/`, unary signs, parentheses, and standard
   precedence. Arithmetic remains filter-only, so it cannot expand the finite fact
   universe; invalid numeric operations fail closed.
4. **Complete — measured engine perf pass**: lazy insertion-ordered first-argument
   indexes accelerate goals whose first term is ground or already bound. Checked-in
   selective-join and recursive-growth controls prove byte-identical rows/proofs, at
   least 2x median speedup, and at least 100x less deterministic relation work.

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

## Phase 17 — Recorded-time knowledge views  *(v0.14)*

1. **Complete — exact journal-position snapshots**: sequence zero represents the state
   before the journal and every later global append position reconstructs facts, rules,
   constraints, identity declarations, and durable sources without timestamp ordering.
2. **Complete — proof and interface parity**: recall, raw query, explanation, integrity
   audit, and listing consume the same read-only snapshot across library, CLI, and MCP;
   graph and identity projection remain derived from that selected view.
3. **Complete — fail-closed completeness**: a full journal replay must reconcile with
   every selected current namespace before past knowledge is returned. Direct edits,
   legacy unjournaled writes, corrupt records, and invalid positions cannot masquerade as
   authoritative history.

## Phase 18 — SQLite semantic parity  *(v0.15)*

1. **Complete — deterministic portable bridge**: advanced SQLite adapter queries reuse
   the bounded portable evaluator for raw conjunctions, stratified negation, arithmetic,
   aggregates, and multi-predicate fixpoints without introducing another durable store.
2. **Complete — explicit execution boundary**: ordinary rules retain the native C path,
   `sqliteDatalogExecutionMode` exposes the selection, and unsupported SQLite values fail
   closed rather than being silently coerced.

## Phase 19 — Explicit temporal corrections  *(v0.16)*

1. **Complete — primary interface parity**: CLI `supersede` and MCP `supersede_facts`
   expose the existing atomic archive-and-replace store primitive without an LLM.
2. **Complete — deterministic valid-time ingress**: callers may supply one canonical UTC
   instant and up to 64 positive fact patterns; ambiguous timestamps and invalid patterns
   fail before mutation while append order remains authoritative.
3. **Complete — authority and retry parity**: raw corrections share integrity enforcement,
   cross-process locks, crash recovery, exact journal lineage, idempotent operation replay,
   structured conflicts, package smoke tests, and historical recall/proof behavior.

## Phase 20 — Deterministic relation indexing  *(v0.17)*

1. **Complete — lazy selective lookup**: positive and negative goals use an
   insertion-ordered first-argument bucket when the term is ground or bound by an earlier
   goal. Unbound scans do not build an index.
2. **Complete — semantic and proof parity**: recursion, semi-naive delta relations,
   aggregate contributors, default and alternative proofs, and the SQLite portable bridge
   retain byte-identical output with indexing disabled as the reproducible control.
3. **Complete — evidence before optimization**: `npm run bench:engine` compares 10k and
   50k-fact selective joins plus 2k-step recursive growth, reports wall time and
   deterministic work counters, and fails below the 2x speedup or 100x work-reduction
   acceptance thresholds.

## Phase 21 — Focused conflict views  *(v0.18)*

1. **Complete — authored focus clustering**: complete integrity violations group by each
   constraint's first alpha-stable binding, while variable-free policy enters one global
   cluster. Rembero never guesses subject semantics from predicate names.
2. **Complete — personal and recorded inspection**: library, CLI `conflicts`, and MCP
   `conflict_views` support optional ground focus terms, canonical aliases, namespace
   unions, exact recorded sequences, proof limits, and complete violation bounds.
3. **Complete — focused graph evidence**: stable conflict nodes and ordered `contains`
   edges combine cross-policy rows, declaration sources, fact proofs, rules, and existing
   selectable graph support without persisting conflict or repair state.

## Phase 22 — Non-empty recall disambiguation  *(v0.19)*

1. **Complete — deterministic ambiguity trigger**: a non-empty query receives one review
   only when its executed predicate has a stronger same-arity, same-anchor competitor or
   a named-state temporal question omits the matching current predicate.
2. **Complete — bounded and honest correction**: the review sees at most three rows and
   four predicate keys, passes external-LLM safety checks, reuses query validation, and
   cannot bypass full-schema widening or manufacture a non-empty result.
3. **Complete — inspectable interface and regressions**: library, CLI, and MCP recall
   expose stable `queryReviews`; canonical identity, recorded snapshots, temporal queries,
   sensitive evidence, and confusable non-empty eval cases have explicit coverage.

## Phase 23 — Reusable aggregate rules  *(v0.20)*

1. **Complete — exact grouped derivation**: `count`, `sum`, `min`, and `max` reductions
   may define an ordinary predicate grouped by every non-output head variable, with
   explicit global/grouped empty-input semantics and existing aggregate row bounds.
2. **Complete — stratified rule composition**: aggregate inputs reach a lower-stratum
   fixpoint before one derivation pass; aggregate chains and ordinary consumers work,
   while every dependency cycle containing aggregation is rejected.
3. **Complete — proof and interface parity**: nested contributor proofs, durable sources,
   graph nodes, canonical identity, recall, integrity enforcement, package APIs, and the
   SQLite portable bridge share the same semantics and fail-closed proof limits.

## Phase 24 — Reviewable knowledge trust  *(v0.21)*

1. **Complete — portable trust authority**: tentative ground facts are stored as bounded
   reserved declarations in the same `.dl` and append-only journal, while accepted facts
   keep their ordinary representation. No confidence score or trust sidecar is added.
2. **Complete — default-safe reads and evidence**: query, recall, explanation, integrity,
   conflict, list, canonical identity, graph, and recorded snapshots exclude tentative
   claims by default; explicit inclusion labels the view, proof, source, and claim node.
3. **Complete — atomic review lifecycle**: library, CLI, and MCP can assert, list, accept,
   or reject exact tentative facts with batch atomicity, retry-safe operation IDs,
   integrity-gated promotion, journaled trust actions, and bounded review output.

## Phase 25 — Immutable journal checkpoints  *(v0.22)*

1. **Complete — non-destructive active-log rotation**: the bounded active `journal.log`
   rotates into ordered SHA-256-addressed segments without truncating history or changing
   any global recorded sequence.
2. **Complete — exact reviewable checkpoints**: every completed boundary records the
   canonical clauses and durable source state for each namespace, then validates that
   state against full deterministic replay before exposing it.
3. **Complete — crash and interface safety**: mutation/journal locks serialize rotation,
   interrupted segment publication is recoverable, dry runs never write, and library,
   CLI, MCP, restart, tamper, missing-segment, and packaged-install paths are covered.

## Phase 26 — Deterministic counterfactual impact  *(v0.23)*

1. **Complete — fact-only read sandbox**: a caller can remove target-namespace ground
   fact patterns and assume up to 64 ordinary ground facts over one consistent current
   snapshot without invoking an LLM or any store writer.
2. **Complete — result and evidence delta**: baseline and candidate queries share the
   full bounded evaluator; added/removed bindings, changed proof evidence, durable and
   explicitly hypothetical sources, rules, identity, trust, and graphs remain inspectable.
3. **Complete — policy and interface delta**: introduced/resolved integrity violations,
   duplicate assumptions, unmatched removals, namespace semantics, input bounds, library,
   CLI, MCP, and packaged-install behavior are explicit and tested.

## Phase 27 — Deterministic why-not explanations  *(v0.24)*

1. **Complete — complete bounded branch diagnosis**: empty relational and aggregate
   queries retain every eliminated conjunction binding and follow matching rule branches
   to missing facts, present negated facts, false comparisons, recursion, or output mismatch.
2. **Complete — sourced nearby evidence and blocker graph**: same-signature facts are
   ranked deterministically by grounded argument agreement, keep ordinary proof/source
   graphs, and connect to query, rule, and failure nodes without persisting a second graph.
3. **Complete — recall and interface parity**: current and recorded library, CLI, MCP,
   canonical identity, tentative trust, recursive, aggregate, and empty recall-explain
   paths share fail-closed depth, frontier, evidence, proof, and output limits.

## Phase 28 — Deterministic knowledge topology  *(v0.25)*

1. **Complete — semantic rule and policy map**: unique facts, alpha-equivalent rule
   groups, authored rule numbers, constraints, comparisons, sources, strata, and
   positive/negative/aggregate dependencies form one deterministic non-persistent graph.
2. **Complete — recursion and open-input inspection**: strongly connected predicate
   components, derived-only relations, undefined inputs, and especially undefined
   closed-world negations are explicit and bounded rather than hidden in source text.
3. **Complete — focused influence and interface parity**: complete upstream, downstream,
   or combined predicate closures retain whole rules and relevant policies across current
   and recorded library, CLI, MCP, identity, trust, namespace, and packaged-install paths.

## Phase 29 — Exact recorded knowledge diff  *(v0.26)*

1. **Complete — coherent semantic endpoints**: two global journal positions are captured
   under one mutation/journal boundary and compared by canonical fact, rule, constraint,
   and provenance identity rather than line text or descriptive timestamps.
2. **Complete — deterministic consequence delta**: topology nodes/edges, open inputs,
   recursion, complete integrity checks, introduced/resolved violations, and optional
   query rows/proofs expose both direct and derived impact.
3. **Complete — historical interface parity**: library, CLI, and MCP support namespaces,
   identity, tentative trust, proof/violation limits, audit-only steps, immutable journal
   segments, packaged installs, and a fail-closed 10,000-clause change boundary.

## Phase 30 — Verified deterministic repair planning  *(v0.27)*

1. **Complete — bounded grounded abduction**: why-not leaves produce ordinary ground-fact
   assumptions or exact base-fact retractions; iterative search discovers sequential
   missing premises and alternative rule plans without inventing rules or metadata.
2. **Complete — minimal counterfactual verification**: every returned plan satisfies the
   query with proof/graph evidence, redundant edits are removed, and strict plus
   no-new-violations policy safety is explicit against one digest-bound baseline.
3. **Complete — proposal-only interface parity**: library, CLI, MCP, identity projection,
   trust views, namespaces, hypothetical provenance, packaged installs, and fail-closed
   plan/depth/state/output bounds share one non-mutating contract.

## Phase 31 — Deterministic rule health audit  *(v0.28)*

1. **Complete — evidence-only finding taxonomy**: undefined negated inputs, policy
   dependencies without definitions, and currently unseeded recursion are warnings;
   open positive inputs, inactive derivations, duplicate semantic rules, and arity
   overload remain informational rather than being mislabeled as invalid programs.
2. **Complete — topology and productivity evidence**: each finding has stable identity,
   exact related predicate/rule/policy nodes, current materialized counts, and `flags`
   edges over the non-persistent topology graph.
3. **Complete — operational interface parity**: current/recorded and focused library,
   CLI, MCP, identity, trust, namespace, package, evaluator/topology/output limits, and a
   warning-only CLI exit `2` share one deterministic audit contract.

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

Version 0.15 closes the material adapter parity gap: raw conjunctions, stratified
negation, arithmetic comparisons, scalar aggregates, and programs with multiple derived
predicates now run through a bounded deterministic bridge over a read snapshot of only
the referenced SQLite tables. The C scalar functions remain a smaller native surface;
constraints and identity remain knowledge-store policies.

Version 0.20 adds reusable grouped aggregate rules to that portable bridge. Native
`datalog_sql` remains the intentionally smaller single-`SELECT` surface and rejects all
aggregate syntax.

The portable store now supplies source-aware valid-time history plus exact recorded-time
journal snapshots. Full interval algebra remains a later, evidence-driven expansion.
Vector composition should reuse existing
SQLite vector infrastructure rather than consume originality budget in this project.

## Explainable personal knowledge graph

The portable `.dl` memory path now retains deterministic first-witness proofs, stable
mutation/source IDs, and query-scoped hypergraphs across the library, CLI, and MCP. This
is the foundation for conflict views, temporal history, and alternative proof inspection
without replacing the readable personal knowledge base with a second graph store.

The measured index pass now removes repeated full relation scans from selective joins
without reordering rules or changing proof bytes. Retrieval context, alternative evidence,
explicit identity projection, integrity audits, and enforced candidate writes remain
bounded independently of knowledge-base growth while the finite, proof-carrying rule
language stays the deterministic authority. Direct hand edits and older writers remain
outside the lock and must be followed by an explicit audit.
