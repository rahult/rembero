# Deterministic personal knowledge paths

Rembero 0.41 answers a local graph question that neighborhood browse does not: “How are
these two entities connected?” It finds every bounded shortest path through explicit
stored ground facts and returns the exact claims, argument positions, provenance, aliases,
trust labels, and recorded-view coordinate supporting each path.

No LLM, vector index, graph sidecar, or materialized inferred edge participates. Portable
`.dl` clauses remain the authority.

## Use

```bash
rembero connect mira rahul
rembero connect mira rahul --path-depth 6 --path-limit 8 --claim-limit 500
rembero connect 'Mira Patel' rahul --entity-identity canonical
rembero connect 42 answer --from-number
rembero connect mira rahul --as-of-sequence 17
```

The library exposes:

```ts
connectKnowledgeGraph(clauses, sources, from, to, options)
```

MCP exposes `connect_knowledge_graph` with `from`, `to`, `maxDepth`, `maxPaths`,
`maxClaims`, namespaces, canonical identity, tentative trust, and recorded sequence.

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

## Honest negative results

`status: "no_path"` is not automatically a claim that the entities are globally
disconnected:

- `searchComplete: true` means the reachable explicit component was exhausted within the
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

Rules and constraints never become relationship claims. Use `explain` when a derived
conclusion and its proof are required, and `topology` for rule dependency paths.
