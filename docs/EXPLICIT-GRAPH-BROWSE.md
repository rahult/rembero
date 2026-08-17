# Bounded explicit personal graph browse

Rembero 0.32 lets callers inspect the stored personal knowledge graph around an entity or
predicate without first generating a Datalog query. The graph is derived on demand from
explicit ground facts only; portable `.dl` clauses remain the sole authority.

## Use

```bash
rembero browse mira
rembero browse mira --browse-depth 3 --claim-limit 200
rembero browse --predicate works_at/2 --browse-depth 2
rembero browse 42 --focus-number
rembero browse mira --as-of-sequence 17
```

The library exposes `browseKnowledgeGraph(clauses, sources, options)`. MCP exposes
`browse_knowledge_graph`. All paths are local, read-only, and require an entity focus,
predicate seed, or both.

## Graph authority

Every ordinary explicit ground fact becomes one existing explanation-graph `claim` node
with `derived: false`. Its atom and numeric arguments become `entity` nodes connected by
ordered `arg` edges. Claim IDs, entity IDs, and edge IDs use the same typed-value shapes as
query explanation graphs.

Rules and constraints do not become claim nodes. Derived facts do not appear merely
because a rule could infer them. Use `query` or `explain` when a conclusion and its proof
are required; use `topology` for rule dependencies.

Durable sources remain on claims. Canonical identity adds alias records and projection
evidence. Tentative facts are hidden by default and labelled when explicitly included;
an accepted exact witness prevents a duplicate tentative witness from downgrading the
claim. Temporal `_until` facts remain ordinary explicit claims, including their timestamp
argument.

## Seeds and depth

An entity seed matches its exact typed value. With canonical identity, an atom alias also
resolves to its canonical value while retaining both focus node IDs. Numeric focus is
distinct from the atom string containing the same digits.

A predicate seed accepts an unambiguous name or explicit `name/arity`. When entity and
predicate are both present, seed facts must match both. Unknown or ambiguous predicates
fail explicitly; an unmatched entity returns `status: "no_match"` with its focus entity
node.

Depth one returns seed claims and all their entities. Each later level adds every explicit
fact sharing a newly reached entity, then its entities. Predicate restricts the seed only;
later levels may traverse other predicates so the neighborhood remains connected.

## Completeness and bounds

Defaults are depth 1 and 100 claims. Hard limits are depth 8, 1,000 claims, 5,000 graph
nodes, 100,000 scanned ground facts, 2,048 bytes for entity focus, 256 bytes for predicate
focus, existing 32-namespace and recorded-history limits, and the 16 MiB CLI/MCP output
boundary.

Claim and node limits are checked while selecting a fact, before constructing oversized
nodes or returning a truncated neighborhood. Programmatically supplied non-ground facts
are skipped and counted; the normal parser/store already rejects them.
