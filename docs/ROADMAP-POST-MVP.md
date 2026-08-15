# Rembero post-MVP roadmap (v0.2 →)

MVP shipped: public repo, CI, GitHub release v0.1.0, npm package ready (publish pending
auth). What follows is ordered by user value per unit of effort — each phase is
independently shippable as a minor release.

## Phase 6 — Reasoning power  *(v0.2, ~2 days)*

The engine's expressiveness ceiling is the first thing power users will hit.

1. **Stratified negation** (`\+ goal` in rule bodies): "employees with no assigned desk".
   Requires a stratification check (reject cyclic negation) and per-stratum fixpoint
   evaluation. The single most-requested Datalog feature.
2. **Aggregation**: `count`, `min`, `max`, `sum` as query-level operators (not in rules,
   keeping termination trivial): "how many people work at Acme?"
3. **Arithmetic in comparisons**: `A > B + 5` style right-hand expressions; still
   filter-only, so no new termination risk.
4. **Engine perf pass**: first-argument indexing for relations (today: linear scan per
   goal). Only matters past ~10k facts; benchmark first.

## Phase 7 — Auto-capture  *(v0.3, ~2 days)*

Today the agent decides when to call `remember`. Auto-capture makes memory ambient:

1. A **Claude Code Stop hook** that hands the session transcript tail to
   `rembero remember --batch` in the background — fully opt-in via
   `rembero init-hooks`.
2. **Noise controls**: extraction prompt tuned for transcripts (ignore code, errors,
   pleasantries); per-namespace daily cap; `journal.log` records every auto-capture so
   nothing is invisible.
3. **Review flow**: `rembero review` lists facts captured in the last N days for
   quick pruning (`forget` by number).

## Phase 8 — Time & provenance  *(v0.4, ~2 days)*

"Where did Mira work *before* Initech?" is unanswerable once supersession retracts the
old fact. Fix by making time first-class:

1. **Valid-time option**: supersession rewrites `works_at(mira, acme)` to
   `works_at_until(mira, acme, <date>)` instead of deleting (config flag; default stays
   simple deletion).
2. **Provenance-aware recall**: answers can cite when/why a fact was stored, pulled from
   the journal.
3. **`rembero history <pattern>`**: the journal filtered to one predicate's life story.

## Phase 9 — Retrieval quality at scale  *(v0.5, ~2-3 days)*

Schema summaries stop fitting in a prompt somewhere around ~100 predicates:

1. **Schema pruning for recall**: rank predicates by lexical/embedding similarity to the
   question, send only the top slice.
2. **Eval harness**: a fixture set of (statement → expected clauses) and (question →
   expected answer) pairs, run against the live model in CI (nightly, not per-push), so
   prompt changes are measured instead of vibed.
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
