# Migrating to Rembero 0.3

Version 0.3 adds scalar query aggregation without changing the existing relational
`parseQuery`, `evaluate`, or `evaluateWithProof` contracts.

## Aggregate-aware query APIs

Use `parseQuerySpec` with `evaluateQuerySpec` or `evaluateQuerySpecWithProof` for code
that accepts both ordinary and aggregate query syntax:

```ts
const query = parseQuerySpec(
  'count(*) as Count where works_at(Person, acme)'
);
const rows = evaluateQuerySpec(clauses, query);
```

`QuerySpec` is discriminated by `kind: 'relational' | 'aggregate'`. Existing callers
that only accept conjunctions can keep using `parseQuery(): Goal[]` unchanged.

## Explanation unions

Core aggregate explanations use `AggregateProof` at the top level of
`ExplainedQueryBindings.proofs`. Knowledge explanations expose the corresponding
`SourcedAggregateProof` through `SourcedQueryProof`:

```ts
for (const proof of row.proofs) {
  if ('aggregated' in proof) {
    console.log(proof.op, proof.value, proof.contributors);
  } else if ('negated' in proof) {
    console.log(proof.predicate, proof.pattern);
  } else {
    console.log(proof.predicate, proof.values);
  }
}
```

The explanation graph adds an `aggregate` node kind and `input`/`witness` edge kinds.
Exhaustive TypeScript switches over graph nodes or edges must handle those additive
members.

## Exactness cap and SQLite

`EvaluateOptions.maxAggregateRows` is separate from `maxRows`. Crossing it throws rather
than returning a partial result. Aggregate explanations additionally default to 256
contributors through `maxAggregateProofRows`; raise it explicitly only when the caller
can accept a larger proof. CLI and MCP JSON responses fail closed above 16 MiB.

The SQLite extension does not yet implement query-level aggregation and rejects its
syntax explicitly.
