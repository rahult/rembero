# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Rembero is for developers and technical evaluators building agents that need durable,
inspectable memory. The public playground also serves people comparing memory and
retrieval approaches who need to see the mechanism rather than accept a product claim.

## Product Purpose

Rembero stores readable facts, rules, and constraints, evaluates exact Datalog queries,
and returns deterministic answers with their proof and source chain. The browser showcase
must let a visitor insert data, inspect SQLite tables, run SQL and Datalog, see result
rows, follow derivations, and watch the knowledge graph change without installing
anything or sending the sample data to a service.

## Positioning

Rembero is proof-carrying agent memory: similarity can find nearby text, while Rembero
shows exactly what follows from the selected knowledge. The showcase must prove that the
database and the Rembero SQLite extension are executing as WebAssembly in the visitor's
browser, not imitate their API in a presentation layer.

## Operating Context

The product is exercised through TypeScript, CLI, MCP, a local web console, and a native
SQLite loadable extension. The public showcase is a static site deployed from GitHub and
must work without a model, API key, account, server mutation endpoint, or network-backed
database. Its sample workspace is fictional and resettable.

## Capabilities and Constraints

- Ordinary SQLite tables remain storage and transaction authority.
- The native extension exposes Datalog planning, query, and explanation functions.
- The browser build must compile the same C extension into the SQLite WebAssembly module;
  browser WebAssembly cannot dynamically load the desktop `.dylib` or `.so`.
- Advanced portable Datalog behavior may remain a separately identified engine path, but
  the interface must never describe a TypeScript-only result as SQLite extension output.
- Every execution path is bounded, deterministic, browser-local, and explicit about
  unsupported syntax.
- Data edits are session-only unless a future requirement explicitly adds device-local
  persistence.
- The site and playground are public; no private user knowledge is bundled or uploaded.

## Brand Commitments

The product name is Rembero. Existing product language includes “Memory you can reason
with,” “Models translate. Rules decide,” “proof-carrying memory,” and honest non-answers.
The current site uses a direct, technically literate voice and avoids claims of universal
correctness, semantic/vector retrieval, or model-free arbitrary natural-language recall.

## Evidence on Hand

- Native SQLite extension: `native/rembero.c`, `native/recursive.c`, and
  `native/sqlite-extension.h`.
- Portable deterministic engine: `src/engine/`.
- SQLite adapter and execution planning: `src/sqlite/extension.ts`.
- Existing browser-contained proof demo: `site/app/playground.tsx` and `site/lib/demo.ts`.
- Public evaluation artifacts and measured transparent baselines: `docs/research/`.
- No customer testimonials, production scale evidence, or external-stack benchmark runs
  are available and none may be fabricated for the showcase.

## Product Principles

1. Demonstrate the mechanism before describing it.
2. Proof, source, and execution boundary remain visible with every answer.
3. Unknown and unsupported remain explicit states, never plausible filler.
4. SQLite is the authority; graph and proof views are projections of the same run.
5. The public demo is safe to explore, deterministic to reset, and honest about scope.

## Accessibility & Inclusion

The IDE must remain fully operable by keyboard, expose clear focus and selected states,
respect reduced motion, and preserve readable code, data, graph, and proof views at desktop
and mobile widths.
