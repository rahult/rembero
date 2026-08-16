# Bounded alternative proofs

Rembero normally returns the first deterministic proof for each query result. That fast
path remains the default. When trust, debugging, or rule authoring requires more evidence,
v0.8 can enumerate every branch-simple proof up to an explicit completeness limit:

```bash
rembero explain 'reachable(a, X)' --proof-limit 4
rembero recall-explain "Why is A reachable?" --proof-limit 4
```

`proofLimit` is also available on the MCP `explain_query` and `recall_explain` tools and
as `RecallOptions.proofLimit` in the library. It counts the primary witness, so `1` is the
unchanged default. The maximum is 16.

## Result contract

The existing `proofs` array remains the primary witness. Additional complete proof
vectors are returned in `alternativeProofs`, in deterministic order:

```json
{
  "bindings": {},
  "proofs": [{ "predicate": "answer", "values": ["a"], "rule": 1 }],
  "alternativeProofs": [
    [{ "predicate": "answer", "values": ["a"], "rule": 2 }]
  ]
}
```

Each vector is aligned with the relational goals in the query. Structural duplicates are
removed. Identical base claims asserted in several selected namespaces remain one logical
proof; the first source stays in `sources`, while the remaining ordered witnesses appear
in `sourceAlternatives` when expanded proof inspection is requested.

When alternatives exist, the query-scoped graph uses proof-instance nodes so different
derivations of one claim do not collapse together:

```text
result --answers--> proof --proves--> claim --arg--> entity
                       |
                       +--because--> proof or absence
```

The primary result edge has no `alternative` field. Alternative result edges carry their
one-based `alternative` index. Without alternative proofs, the compact pre-v0.8 graph
shape is unchanged.

## Deterministic and bounded semantics

Alternative enumeration runs only after the ordinary stratified semi-naive evaluator has
computed the final least model. It does not change whether a fact is true and it does not
add a persisted proof index.

Proofs are ordered by:

1. stored fact before a derived copy of the same claim;
2. rule number;
3. rule-body order;
4. final-relation insertion order;
5. recursively ordered child proofs.

Recursive proofs are branch-simple: a grounded claim cannot repeat on one root-to-leaf
branch. This removes cyclic self-support and makes proof trees finite even when the fact
graph contains cycles.

Rembero never silently labels a partial evidence set as complete. If more structurally
distinct proofs exist than `proofLimit`, or enumeration exceeds its internal search cap,
the explanation fails with an `EngineLimitError`. Existing global proof-depth, proof-node,
row, fact, output, and MCP result limits still apply across the primary and alternative
proofs together.

Alternative proofs are relational-only in v0.8. Scalar aggregate explanations already
carry their exact ordered contributor set and reject `proofLimit > 1` rather than mixing
two completeness models.

## Authority boundary

Portable `.dl` files remain the only knowledge authority. The least model, alternatives,
sources, and graphs are all ephemeral deterministic projections over the selected
namespaces. Recall schema pruning still affects only LLM query generation; accepted
queries and every proof are evaluated against the complete allowed clause set.
