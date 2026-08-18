# Deterministic personal knowledge paths

Remembero 0.41 answers a local graph question that neighborhood browse does not: “How are
these two entities connected?” It finds every bounded shortest path through explicit
stored ground facts and returns the exact claims, argument positions, provenance, aliases,
trust labels, and recorded-view coordinate supporting each path.

No LLM, vector index, or graph sidecar participates. Explicit mode does not materialize
inference; derived mode materializes only in memory for discovery. Portable `.dl` clauses
and proof evaluation remain the authority.

Version 0.42 adds opt-in rule-derived traversal. It uses bounded fixpoint materialization
to discover connections, then attaches a complete deterministic proof to every claim on
the selected shortest paths. Derived edges are never persisted.

## Use

```bash
remembero connect mira rahul
remembero connect mira rahul --path-depth 6 --path-limit 8 --claim-limit 500
remembero connect 'Mira Patel' rahul --entity-identity canonical
remembero connect 42 answer --from-number
remembero connect mira rahul --as-of-sequence 17
remembero connect mira rahul --include-derived
```

The library exposes:

```ts
connectKnowledgeGraph(clauses, sources, from, to, options)
```

MCP exposes `connect_knowledge_graph` with `from`, `to`, `maxDepth`, `maxPaths`,
`maxClaims`, namespaces, canonical identity, tentative trust, and recorded sequence.
Set `includeDerived: true` (or CLI `--include-derived`) to traverse rule conclusions.

## Path semantics

The explicit fact graph is a hypergraph. A fact such as `works_at(mira, acme).` is one
claim node connected to ordered entity arguments. Traversal treats those argument edges
as undirected for connectivity while retaining their authored positions.

For:

```prolog
works_at(mira, acme).
works_at(rahul, acme).
```

the path from `mira` to `rahul` has two claim hops:

```text
mira -> works_at(mira, acme) -> acme -> works_at(rahul, acme) -> rahul
```

Each returned segment includes the claim ID, predicate, endpoint values and IDs, and the
two argument positions used. The result graph is the union of only the returned shortest
paths; claim nodes retain the same durable sources and projection evidence as explicit
graph browse.

All shortest paths are returned in stable structural order. A direct fact wins over every
longer relationship. If more shortest alternatives exist than `maxPaths`, the operation
fails rather than presenting a partial set as complete.

## Proof-carrying derived paths

Explicit facts remain the default. With derived traversal enabled, Remembero first applies
the same bounded stratified Datalog fixpoint used by query evaluation. A rule conclusion
such as `reachable(a, c)` may therefore be a one-hop semantic relationship even when its
proof uses several stored `edge` facts.

Materialization is discovery only. After shortest paths are selected, every distinct path
claim is re-evaluated through `explainKnowledge` against the original current or recorded
view. `claimProofs` contains the resulting sourced derivations, and `rules` contains only
the authored rule numbers actually reached by those proof trees. The returned graph merges
the path with its `because`, absence, aggregate-input, witness, entity, and source evidence.

Path segments label `derived` and the root `rule` when applicable. Explicit segments in a
derived-mode path also receive leaf proofs, so no selected hop is unaudited. Recursive,
closed-world-negated, aggregate-derived, canonicalized, and tentative conclusions retain
the same proof semantics as ordinary explanation queries.

## Honest negative results

`status: "no_path"` is not automatically a claim that the entities are globally
disconnected:

- `searchComplete: true` means the reachable selected component was exhausted within the
  claim bound; no path exists in that selected knowledge view.
- `searchComplete: false` means the configured depth stopped traversal while unvisited
  adjacent claims remained. No path was found within `maxDepth`.

Claim and node overflow also fail before returning a partial result.

## Identity, trust, and time

Atom and numeric entities remain distinct. With canonical identity enabled, each endpoint
is resolved through explicit position-scoped alias declarations, canonical entity nodes
retain alias evidence, and projected claims retain `projectedFrom` and rewrite records.

Tentative claims are excluded by default. `include_tentative` may connect a path through
them, in which case the claim nodes are visibly labelled. An accepted duplicate witness
remains accepted.

Current and exact recorded snapshots use the same path algorithm. Multi-namespace source
witnesses and `_until` temporal facts remain attached to their explicit claims.

## Bounds

Defaults are four claim hops, three complete shortest paths, and 100 explored claims.
Hard limits are eight hops, 16 paths, 1,000 claims, 5,000 graph nodes, 100,000 scanned
ground facts, 2,048 bytes per endpoint, existing namespace/history bounds, and the 16 MiB
CLI/MCP output boundary.

Rules and constraints never become persisted relationship claims. Derived conclusions are
available only through the explicit opt-in proof-carrying mode. Use `explain` for a known
conclusion and `topology` for rule dependency paths.
