# Explainable personal knowledge graph

Rembero's personal memory remains portable Datalog in `.dl` files. The graph is a
deterministic projection of query results and their derivation proofs, not a second store
that can drift from the facts.

```bash
rembero explain 'colleague(rahul, Who)'
rembero recall-explain "Who are Rahul's colleagues?"
```

The equivalent MCP tools are `explain_query` and `recall_explain`.

An explanation contains:

- the query bindings;
- the first deterministic derivation proof for every relational query goal;
- the query-local rule ordinals and clauses used by those proofs;
- source metadata for asserted facts: namespace, operation ID, timestamp, and the
  original natural-language statement when the fact came from `remember` (credential-
  like or financial identifiers are redacted before journaling);
- a query-scoped hypergraph of results, claims, entities, and support relationships.

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
- When several rules, paths, or namespaces prove the same claim, the first witness wins:
  query-local rule order, requested namespace order, body order, then fact insertion
  order. Only that witness source is attached to the proof.
- Comparisons filter a proof but do not create claim nodes.
- Derivation, row count, fact count, iteration count, and proof depth remain bounded and
  fail closed when their configured caps are exceeded.
- Namespace wildcard reads are sorted before evaluation so filesystem enumeration order
  cannot change the chosen witness.
- Inputs that resemble credentials or financial identifiers are rejected before any
  external LLM call. Direct-store provenance is still redacted before journaling as a
  defense in depth.

Namespaces organize one local personal store; they are not tenant or authorization
boundaries. Run separate Rembero processes and storage roots where access isolation is
required.

The graph is intentionally query-scoped. A global materialized graph browser, temporal
history, conflict sets, and alternative-proof enumeration should build on this contract
rather than introduce another source of truth.
