# Explainable personal knowledge graph

Rembero's personal memory remains portable Datalog in `.dl` files. The graph is a
deterministic projection of query results and their derivation proofs, not a second store
that can drift from the facts.

```bash
rembero explain 'colleague(rahul, Who)'
rembero recall-explain "Who are Rahul's colleagues?"
```

The equivalent MCP tools are `explain_query` and `recall_explain`.

Version 0.12 can select a deterministic subgraph for transport or focused inspection:

```bash
rembero explain 'ancestor(alice, Descendant)' --graph-result 2
rembero explain 'ancestor(alice, Descendant)' --graph-support '<node-id>'
rembero explain 'ancestor(alice, Descendant)' --graph-neighbors '<node-id>' --graph-depth 2
```

Selection preserves the complete result, proof, and rule arrays. A result or support
selector follows the complete explanation support closure; a neighborhood selector is
an undirected breadth-first slice capped at depth 8. The response records the normalized
selector, focus node IDs, and original graph sizes. See
[the graph-navigation contract](GRAPH-NAVIGATION.md).

An explanation contains:

- the query bindings;
- the first deterministic derivation proof for every relational query goal;
- the query-local rule ordinals and clauses used by those proofs;
- exact scalar aggregate proofs with every ordered contributor row when the query uses
  `count`, `sum`, `min`, or `max`;
- source metadata for asserted facts: namespace, operation ID, timestamp, and the
  original natural-language statement when the fact came from `remember` (credential-
  like or financial identifiers are redacted before journaling);
- for system-managed `_until` facts, the preceding clause and exact valid-until instant
  from the atomic supersession event;
- a query-scoped hypergraph of results, claims, entities, and support relationships.

Pass a proof limit above one to request bounded alternative derivations. The existing
`proofs` field remains the first witness; `alternativeProofs` contains additional complete
proof vectors. Expanded graphs introduce proof-instance nodes and `proves` edges so
distinct derivations of the same grounded claim do not merge. See
[the alternative-proof contract](ALTERNATIVE-PROOFS.md).

Successful `\+ literal` goals appear as atomic `absence` nodes. They record the grounded
pattern and completed lower stratum that was checked, but never claim a stored source or
enumerate non-matches. A failed negative goal yields no result and therefore no invented
failure proof.

Scalar query reductions appear as `aggregate` nodes. Ordered `input` edges connect the
aggregate to contributor result rows, whose ordinary proofs retain their sources.
`min`/`max` add `witness` edges for every tied extremum. The aggregate node itself never
claims a source because it is a deterministic calculation over query results.

## Why a hypergraph

Datalog supports zero-arity, unary, binary, and wider predicates. Converting everything
to subject-predicate-object triples would discard positional meaning for wider facts.
Rembero therefore represents each grounded literal as a claim node:

```text
result {Who: mira}
  └─ answers ─> claim colleague(rahul, mira)
                    ├─ arg[0] ─> entity rahul
                    ├─ arg[1] ─> entity mira
                    ├─ because[0] ─> claim works_at(rahul, acme)
                    └─ because[1] ─> claim works_at(mira, acme)
```

Node and edge IDs are collision-safe encodings of typed values and graph roles. Arrays
are sorted by ID, while `position` preserves query-goal, rule-body, and argument order.
Repeated evaluation over the same ordered clauses produces byte-for-byte equivalent
proof and graph objects.

## Deterministic boundary

- Stored facts win over derived copies of the same claim.
- By default, when several rules, paths, or namespaces prove the same claim, the first
  witness wins: query-local rule order, requested namespace order, body order, then fact
  insertion order. Expanded proof inspection preserves that witness and adds bounded,
  ordered structural alternatives plus other active namespace sources.
- Comparisons, including bounded arithmetic expressions, filter a proof but do not create
  claim nodes. The positive facts that grounded every arithmetic variable remain in the
  proof, and the canonical rule text retains the exact expression.
- Successful negated literals create source-free absence nodes in body order.
- Scalar aggregates inspect the complete result set up to `maxAggregateRows`; exceeding
  the cap fails instead of returning a partial value.
- Derivation, row count, fact count, iteration count, and proof depth remain bounded and
  fail closed when their configured caps are exceeded.
- Namespace wildcard reads are sorted before evaluation so filesystem enumeration order
  cannot change the chosen witness.
- Recall schema pruning changes only the bounded query-generation prompt. The accepted
  query, proof, sources, and graph are always computed from the full allowed clause set,
  so ranking cannot change the first deterministic witness.
- Inputs that resemble credentials or financial identifiers are rejected before any
  external LLM call. Direct-store provenance is still redacted before journaling as a
  defense in depth.

Namespaces organize one local personal store; they are not tenant or authorization
boundaries. Run separate Rembero processes and storage roots where access isolation is
required.

The graph is intentionally query-scoped. Temporal history now builds on this contract by
keeping `_until` facts in the same portable `.dl` authority and adding temporal fields to
their existing source objects. Alternative-proof enumeration does so ephemerally in
v0.8. Explicit headless integrity constraints reuse the same projection in v0.9: every
violating row carries its ordinary proof/source graph, grouped beneath the exact policy
that rejected that state. No conflict graph is persisted globally and ordinary query
graphs remain unchanged. Version 0.10 returns that same ephemeral graph in atomic
write-rejection evidence; it does not materialize enforcement state as another graph.
Version 0.12 adds pure navigation over these ephemeral graphs while preserving the same
portable authority and deterministic node/edge ordering.
