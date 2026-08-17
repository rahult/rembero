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
3. **Complete — measured model flexibility**: the full grounded 26-case recall corpus was
   run against three additional OpenRouter models. Gemini 3.7 Flash and Claude Sonnet 5
   matched the default's 100%; GPT-5.4 Mini scored 92.3% by leaking rule-local helper
   variables. The dated price snapshot and recommendation are documented without changing
   the default model; v0.40 separately closes the extraction-evidence boundary.

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

## Phase 32 — Grounded deterministic negative recall  *(v0.29)*

1. **Complete — final-query blocker evidence**: after bounded schema widening and the one
   translation-review fallback, a full-schema empty query receives one complete why-not
   tree and source-text-free deterministic summary.
2. **Complete — no negative phrasing authority**: ordinary and explained no-match recall
   return the local summary without a third LLM call; answered recall retains its existing
   grounded phrasing path.
3. **Complete — honest diagnostic fallback**: why-not limit exhaustion preserves the exact
   empty result, emits typed `whyNotUnavailable` evidence, and uses a generic deterministic
   answer across library, CLI/MCP/package behavior without misrepresenting partial blockers.

## Phase 33 — Deterministic positive answer mode  *(v0.30)*

1. **Complete — exact local rendering**: boolean, single-row, multi-row, aggregate, and
   tentative-labelled successful bindings render in stable authored variable/row order
   with the existing output bound.
2. **Complete — explicit compatibility boundary**: natural LLM phrasing remains default;
   per-call, CLI, MCP, programmatic server, and environment configuration can opt into
   deterministic mode without changing query generation, review, widening, or proofs.
3. **Complete — reduced model authority and cost**: deterministic successful recall uses
   one query-generation call (plus the existing fallback only when empty), while v0.29
   negative recall stays deterministic in both modes.

## Phase 34 — Deterministic local knowledge search  *(v0.31)*

1. **Complete — inspectable lexical retrieval**: facts, rules, and policies receive fixed
   integer scores from exact source/clause phrases, head/body predicates, ground terms,
   source/clause words, and bounded predicate typo distance, with every reason returned.
2. **Complete — provenance and graph evidence**: matches retain redacted durable sources,
   hypothetical/trust/identity projection, and a non-persistent search/result/clause/
   predicate/entity graph with distinct define/dependency edges.
3. **Complete — local interface parity and honest scope**: current/recorded library, CLI,
   MCP, namespace, kind/limit/truncation, package, input/source/clause/output bounds, and
   explicit no-match behavior work without an LLM while never claiming semantic proof.

## Phase 35 — Bounded explicit personal graph browse  *(v0.32)*

1. **Complete — stored-fact hypergraph authority**: only explicit projected ground facts
   become claim nodes; every argument becomes an entity edge with durable provenance,
   aliases, trust, temporal values, and no rule-derived claim materialization.
2. **Complete — complete bounded neighborhoods**: entity and/or predicate seeds expand by
   shared entities at exact depth, failing before partial output when claim, node, fact,
   focus, or namespace bounds are exceeded.
3. **Complete — local interface parity**: current/recorded library, CLI, MCP, atom/numeric
   focus, identity, tentative/accepted witnesses, multi-namespace sources, package, and
   explicit no-match behavior share the existing explanation graph IDs and edge shapes.

## Phase 36 — Content-addressed portable knowledge bundle  *(v0.33)*

1. **Complete — raw namespace authority and provenance**: canonical facts, rules,
   constraints, trust/identity metadata, and namespace-filtered durable sources export
   without projecting a read view or depending on internal checkpoint layout.
2. **Complete — deterministic identity and standalone verification**: normalized bytewise
   namespace/clause/source order, current or exact recorded coordinates, resource bounds,
   temporal/trust lineage, and SHA-256 are verified without a store or mutation.
3. **Complete — artifact interface parity**: compact library serialization, regular-file
   CLI export/verify, raw MCP transport, multi-namespace duplicates, checkpointed stores,
   empty bundles, tamper tests, package installs, and 16 MiB output limits share one format.

## Phase 37 — Provenance-aware recall schema ranking  *(v0.34)*

1. **Complete — bounded local source signals**: redacted durable source statements add
   fixed exact-word and phrase scores within 4,096 characters per predicate, composed
   with existing predicate, fact, rule, temporal, and typo ranking.
2. **Complete — no prompt leakage or semantic shortcut**: source text changes selection
   only; prompts still contain predicate names, selected rules, and syntax sample facts,
   while complete evaluation and dependency closure remain authoritative.
3. **Complete — inspectable recall parity**: source-matched selected signatures appear in
   pruning diagnostics across widening, trust, identity, recorded views, scale tests,
   library/package APIs, and existing question/schema/output bounds.

## Phase 38 — Portable deterministic knowledge checks  *(v0.35)*

1. **Complete — bounded suite contract**: standalone JSON v1 carries up to 64 unique named
   queries expecting empty, non-empty, exact ordered rows, or duplicate-free row sets with
   canonical serialized binding values and aggregate row/name/input bounds.
2. **Complete — evidence-backed regression failure**: compact passes and rich failures
   expose actual/missing/unexpected rows, pure order mismatch, query proofs/graphs, or
   complete why-not blockers without storing tests or invoking an LLM.
3. **Complete — CI and historical parity**: current/recorded library, regular-file CLI exit
   `2`, MCP, trust, identity, namespaces, proof limits, optional passing evidence, package,
   malformed-suite, and 16 MiB result boundaries share one immutable execution view.

## Phase 39 — Semantic rule coverage  *(v0.36)*

1. **Complete — proof-derived semantic hits**: primary, alternative, recursive, nested,
   and aggregate proof trees contribute authored rule numbers, then alpha-equivalent
   definitions collapse into one stable semantic coverage unit.
2. **Complete — inspectable coverage report**: every rule group returns clause, authored
   numbers, covering check names, covered flag, deterministic percentage, and uncovered
   counts; programs without rules are 100% covered.
3. **Complete — optional CI gate**: JSON v1 suites may require integer coverage 0–100;
   coverage-only failure preserves passed row counts, runs all checks, exits CLI `2`, and
   composes with current/recorded identity, trust, proof limits, MCP, and package paths.

## Phase 40 — Schema-only SQLite Datalog planning  *(v0.37)*

1. **Complete — deterministic routing plan**: rule programs, raw conjunctions, and
   aggregates expose native versus portable mode, execution boundary, input kind, result
   relation/variables, derived predicate arities, and transitive recursion before execution.
2. **Complete — transaction-safe schema evidence**: referenced main/temp tables and views,
   visible/generated columns, declared types, arity, optional one-SELECT native SQL, and
   active resource bounds are validated inside a savepoint without scanning rows.
3. **Complete — adapter and artifact parity**: public `DatalogDatabase`, `sqlite-plan` CLI,
   native/portable/temp/view/generated/missing/arity/no-row-scan tests, installed package,
   and Node 22+ SQLite gates share the execution schema used by portable loading.

## Phase 41 — Deterministic query work profiling  *(v0.38)*

1. **Complete — stable engine counters**: ordinary, recursive, aggregate, identity, trust,
   current, and recorded queries return exact relation lookups, indexed lookups, index
   facts processed, and candidate facts visited beside normal proofs and graphs.
2. **Complete — indexed/scan equivalence gate**: optional comparison reruns with relation
   indexes disabled, refuses mismatched explanation bytes, and reports candidate visits
   avoided plus a deterministic ratio without timing measurements.
3. **Complete — interface and evidence parity**: library, CLI `profile`, MCP
   `profile_query`, graph/proof selection, package installs, selective scale controls,
   runtime option validation, and 16 MiB result bounds share one read-only contract.

## Phase 42 — Verified cross-model recall  *(v0.39)*

1. **Complete — bounded semantic rule visibility**: inverse grandparent/grandchild
   wording receives one deterministic kinship ranking token, keeping the authored derived
   head and complete dependency closure visible under 100 distractor predicates.
2. **Complete — helper-variable guardrail**: the grounded query contract tells compatible
   models to query a directly matching derived head rather than presenting internal join
   variables as requested answers, with local and live-model regression evidence.
3. **Complete — honest compatibility guidance**: four current OpenRouter models ran the
   same 26-case engine-backed corpus; results, observed prices, latency caveat, default
   decision, and the recall-only evidence boundary are checked in.

## Phase 43 — Exact personal knowledge extraction evaluation  *(v0.40)*

1. **Complete — engine-backed mutation corpus**: 15 labeled cases run through the real
   `rememberText` and `MemoryStore` path, covering facts, schema reuse under 100
   distractors, duplicates, corrections, removals, rules, trust, no-ops, and secret
   rejection.
2. **Complete — semantic and authority-aware scoring**: alpha-equivalent rules compare
   canonically; signed mutation precision/recall/F1 excludes unchanged initial facts;
   exact accuracy also checks final state, operation counts, expected rejection, and
   zero-call local safety.
3. **Complete — explicit tentative extraction contract**: accepted mode skips hedged
   claims, tentative caller authority is visible to extraction without granting metadata
   authority to the model, and alias-only text cannot become an inert identity surrogate.
4. **Complete — cross-model evidence**: Luna, Gemini 3.7 Flash, and Claude Sonnet 5 passed
   15/15; GPT-5.4 Mini scored 14/15. Combined recall/extraction results retain Luna as the
   verified default and keep final prose phrasing outside the claim.

## Phase 44 — Deterministic personal knowledge paths  *(v0.41)*

1. **Complete — explicit hypergraph shortest paths**: atom or numeric endpoints traverse
   ordered argument edges through explicit ground-fact claim nodes; every shortest path
   is returned in stable order with predicate, argument-position, and entity steps.
2. **Complete — honest bounded completeness**: depth-bounded misses differ from exhausted
   disconnected components, claim/node overflow fails before partial output, and excess
   equal-length alternatives fail rather than masquerading as a complete shortest set.
3. **Complete — evidence and view parity**: the path-only graph retains durable sources,
   canonical aliases/projections, accepted/tentative labels, temporal facts, namespace
   witnesses, and exact recorded coordinates without an LLM or graph sidecar.
4. **Complete — operational parity**: library, CLI `connect`, MCP
   `connect_knowledge_graph`, numeric endpoints, package installs, current/recorded tests,
   and existing 16 MiB output bounds share one read-only contract.

## Phase 45 — Proof-carrying derived knowledge paths  *(v0.42)*

1. **Complete — explicit opt-in semantic shortcuts**: bounded fixpoint materialization
   may contribute rule-derived hyperedges to shortest-path discovery without changing the
   default explicit-only graph or persisting inferred claims.
2. **Complete — every selected hop is explained**: distinct path claims are re-evaluated
   against the original view; sourced recursive, negated, aggregate, identity, and trust
   proof trees plus only their used authored rules are returned and merged into the graph.
3. **Complete — authority and resource parity**: current/recorded namespaces, canonical
   aliases, tentative premises, 100,000-fact materialization, depth/path/claim bounds, and
   fail-closed proof/output limits preserve the query engine's semantics.
4. **Complete — operational parity**: library `includeDerived`, CLI `--include-derived`,
   MCP `includeDerived`, packaged installs, and cross-interface regressions share the same
   non-mutating proof-carrying contract.

## Phase 46 — Proposal-only deterministic rule change impact  *(v0.43)*

1. **Complete — exact program proposals**: up to 64 ordinary/aggregate rules may be
   appended and 64 alpha-equivalent rules removed from one target namespace on a coherent
   current or exact recorded baseline; facts and policy authority remain separate.
2. **Complete — consequence and structure evidence**: baseline/candidate query proofs,
   provenance, integrity, full rule audits/topologies, stable finding changes, and topology
   node/edge deltas share one immutable candidate.
3. **Complete — regression and semantic coverage gate**: an optional portable JSON v1
   suite runs against both programs and reports fixed/regressed checks, coverage movement,
   and coverage pass/fail regression without storing test or proposal state.
4. **Complete — operational and authority parity**: library, CLI `what-if` rule flags, MCP
   `what_if`, namespaces, identity, trust, recorded coordinates, hypothetical rule sources,
   packages, and fail-closed bounds remain proposal-only and non-mutating.

## Phase 47 — Digest-bound reviewed rule application  *(v0.44)*

1. **Complete — portable review artifact**: effective current rule previews emit JSON v1
   binding ordered multi-namespace program digest, exact rules, review query, normalized
   suite, view modes, and a content SHA-256; any edit invalidates the proposal.
2. **Complete — atomic authority boundary**: explicit apply requires a stable operation ID,
   exact current digest, candidate rule audit, attached check/coverage pass, and mandatory
   no-new-integrity-violations enforcement under the cross-process mutation lock.
3. **Complete — durable lifecycle**: one crash-recoverable `rule_change` journal event
   replays through sources, exact recorded snapshots/diffs, checkpoints, idempotent retries,
   conflicts, and hypothetical-to-durable rule provenance.
4. **Complete — operational parity**: library, CLI `apply-rule-change`, MCP
   `apply_rule_change`, package installs, structured stale/check/integrity errors, tamper,
   concurrency, recorded-only rejection, and 16 MiB evidence bounds share one contract.

## Phase 48 — Proposal-first accepted personal memory  *(v0.45)*

1. **Complete — one extraction authority path**: direct remember and non-mutating proposal
   share identical prompts, retry, parsing, secret, rule, identity, trust, and retraction
   validation; no second model interpretation is introduced.
2. **Complete — exact candidate evidence**: extraction is expanded over one post-LLM
   coherent baseline into exact additions/removals, temporal archives, integrity deltas,
   and optional rule audit/topology impact without calling a writer.
3. **Complete — content-addressed review artifact**: versioned SHA-256 proposals bind
   ordered governed program state, source text, exact clauses, time policy/instant, and
   identity view; duplicates and non-factual input produce no artifact.
4. **Complete — operational and trust boundary**: library, CLI `propose-memory`, MCP
   `propose_memory`, namespaces, packages, secret zero-call behavior, and existing output
   limits target reviewed accepted knowledge while tentative claims keep their own flow.

## Phase 49 — Digest-bound reviewed personal memory application  *(v0.46)*

1. **Complete — exact mixed-clause authority**: one reviewed artifact may atomically add
   facts/rules, remove exact facts/rules, and add validated temporal archives without
   wildcard re-evaluation or partial commits.
2. **Complete — in-lock safety**: content and current program digests, exact presence,
   candidate rule audit, and mandatory no-new-integrity enforcement are revalidated under
   the cross-process mutation lock before crash-safe commit.
3. **Complete — durable semantic lifecycle**: `memory_change` replays through sources,
   fact retraction/supersession history, temporal lineage, recorded snapshots/diffs,
   checkpoints, bundles, and original-sequence idempotency.
4. **Complete — operational parity**: library, CLI `apply-memory`, MCP
   `apply_memory_proposal`, package installs, tamper/stale/integrity/conflict errors, and a
   competing-process race share one explicit human-authorized accepted-memory contract.

## Phase 50 — Explicit deterministic relational projection  *(v0.47)*

1. **Complete — answer-column authority**: `select X, Y where goals` declares ordered
   result variables separately from helper variables while legacy all-variable and ground
   relational queries remain backward compatible.
2. **Complete — correct projected relation semantics**: deduplication and row bounds apply
   after projection; alternative derivations merge beneath one answer row without losing
   complete proof enumeration or exposing internal joins.
3. **Complete — grounded recall integration**: variable-bearing natural-language queries
   must select only requested unknowns, preventing valid inlined rule bodies from turning
   helper variables into plausible answer columns.
4. **Complete — engine and interface parity**: parser/serializer, identity, proofs,
   why-not, checks, profiles, CLI/MCP, SQLite portable execution/planning, package installs,
   and model eval normalization share the same projection contract.

## Phase 51 — Immutable deterministic personal knowledge health  *(v0.48)*

1. **Complete — one coherent evidence state**: current or exact recorded clauses and
   sources feed integrity, rule audit/topology, trust, identity, provenance, and optional
   regression/coverage checks without recapturing between components.
2. **Complete — actionable status without semantic guessing**: healthy/review/violations
   and stable finding codes summarize only explicit policy, warnings, checks, tentative
   debt, and missing source evidence.
3. **Complete — provenance and identity maintenance**: per-namespace clause instances must
   have same-namespace durable witnesses; aliases/positions validate and retain sources;
   the state digest changes for clause or provenance changes.
4. **Complete — operational parity**: library, CLI `health`, MCP `knowledge_health`,
   package installs, current/recorded, check suites, view modes, meaningful exit codes,
   and fail-closed finding/detail/output bounds share one read-only contract.

## Phase 52 — Regression-gated reviewed personal memory  *(v0.49)*

1. **Complete — suite-bound review evidence**: optional portable JSON v1 checks and
   semantic coverage execute on baseline/candidate memory and expose fixed/regressed names,
   coverage movement, and pass/fail transitions.
2. **Complete — content-bound expectations**: normalized suite text is embedded in and
   covered by the memory proposal digest, so altering any expectation invalidates review.
3. **Complete — in-lock regression gate**: apply re-runs the bound suite on the complete
   candidate under the mutation lock and rejects all row or coverage failures before write.
4. **Complete — operational parity**: library, CLI `--check-suite`, MCP, package installs,
   structured failure/exit status, durable post-commit evidence, and existing suite bounds
   compose with stale, audit, and integrity gates.

## Phase 53 — All-writer knowledge check enforcement  *(v0.50)*

1. **Complete — one central candidate hook**: every supported facts/rules/trust/temporal/
   capture/proposal writer reaches the same baseline/candidate suite evaluation under the
   global mutation lock with prospective source evidence.
2. **Complete — strict and migration-safe modes**: strict requires a green candidate;
   no-regressions permits legacy failures and repairs while blocking newly failed names,
   coverage decreases, or coverage pass-to-fail transitions.
3. **Complete — independent composed authority**: check and integrity enforcement may
   govern explicit namespace unions independently, but both evaluate the same locked
   candidate and neither can weaken the other.
4. **Complete — operational parity**: library contexts, server/tool defaults, CLI/MCP env,
   direct remember, ambient capture, trust, reviewed apply, package installs, structured
   error/exit `8`, and fail-closed suite bounds share one invariant.

## Phase 54 — Compact deterministic evidence recall  *(v0.51)*

1. **Complete — readable local provenance**: positive rows render projected bindings,
   claims, rules, absences, aggregates, projections, trust, temporal lineage, and durable
   sources without an LLM phrasing call.
2. **Complete — proof-complete compaction**: primary and requested alternative proof trees
   are traversed under existing bounds, then stable sets deduplicate repeated support while
   preserving every selected evidence category.
3. **Complete — honest negative continuity**: no-match keeps deterministic why-not;
   unanswerable and budget-exhausted statuses retain explicit local messages and never call
   the phrasing model.
4. **Complete — operational parity**: library renderer/options, CLI, MCP, environment
   default, accepted/tentative, aggregate/absence/source tests, package install, canonical
   value formatting, and 16 MiB output bound share one mode.

## Phase 55 — Deterministic related-knowledge recall  *(v0.52)*

1. **Complete — actionable non-answers**: opt-in related local search accompanies final
   no-match, unanswerable, and schema-budget states without changing their status, query,
   bindings, why-not evidence, or answer.
2. **Complete — exact view continuity**: suggestions use the same captured clauses,
   sources, namespaces, canonical identity, tentative trust, and recorded coordinate as
   the primary recall attempt.
3. **Complete — explicit discovery boundary**: fixed lexical scores, reasons, provenance,
   and the retrieval graph remain visibly separate from logical proof and answer authority;
   no vector, graph sidecar, or extra LLM call participates.
4. **Complete — operational parity**: library options/result types, CLI text and JSON,
   MCP fields, package installs, current/recorded tests, kind/result limits, and fail-closed
   search/output bounds share one contract.

## Phase 56 — Real-use-case local web console  *(v0.53)*

1. **Complete — evidence-first personal workflow**: one sourced Atlas briefing exercises
   structured capture, exact guided recall, rule-derived answers, honest non-answers,
   related discovery, lexical search, health, and explicit graph browse against the real
   engine.
2. **Complete — modern responsive product surface**: React/Vite desktop and mobile layouts
   share a deliberate evidence-desk design system, accessible navigation, proof/source
   hierarchy, capture drawer, graph/list parity, loading/error states, and reduced motion.
3. **Complete — bounded local service**: one loopback HTTP origin wraps existing tool
   contracts, preserves input/output limits and source redaction, rejects cross-origin
   mutation, hides model credentials, and refuses all non-loopback binding.
4. **Complete — distributable verification**: public service/server APIs, prebuilt packaged
   client, loopback integration tests, browser interaction and responsive QA, package smoke,
   and existing core/SQLite gates share one release.

## Phase 57 — Hosted product marketing playground

1. **Complete — proof-first product narrative**: a responsive marketing surface explains
   readable memory, deterministic rules, proof-carrying answers, honest unknowns, the
   model boundary, and MCP/TypeScript/CLI integration without unverified claims.
2. **Complete — real browser engine**: fixed natural-language presets map visibly to
   canonical queries evaluated by the actual pure TypeScript engine under strict bounds;
   supported, non-answer, session-only correction, source, and reset states are interactive.
3. **Complete — safe hosted boundary**: the deployed Sites project uses fictional data,
   makes no network/model/storage calls from the playground, and leaves D1/R2 disabled;
   the personal local server remains loopback-only and is never exposed.
4. **Complete — hosted delivery**: coordinated desktop/mobile concepts, bespoke social
   preview, vinext build/render tests, lint, browser QA, saved source version, private
   production deployment, and durable project metadata share one milestone.

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
