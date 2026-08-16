# Deterministic relation indexing

Version 0.17 makes selective rules and queries scale without changing Rembero's
evaluation order, proof order, or durable knowledge format.

## Contract

The portable evaluator keeps each predicate's canonical tuple map in insertion order.
When a positive or negative goal has a ground first argument—either written directly or
bound by an earlier goal—the evaluator lazily builds an in-memory index for that
predicate and reads only the matching bucket.

The index is derived execution state:

- it is never persisted and cannot become a second knowledge authority;
- buckets retain canonical tuple insertion order, so first-witness and alternative-proof
  order are unchanged;
- the same lookup path serves base facts, semi-naive delta relations, recursive rules,
  negation, aggregate contributors, ordinary queries, and the SQLite portable bridge;
- unbound first arguments keep the original full insertion-order scan and do not build an
  index;
- tuple deduplication, fact/iteration/row/proof limits, and fail-closed numeric validation
  are unchanged.

No goal reordering occurs. Rule body order remains authored policy and is still visible
in derivation proofs.

## Reproducible benchmark

Run:

```bash
npm run bench:engine
```

The checked-in benchmark compares indexed evaluation with the same engine's
`relationIndex: 'off'` control over selective joins at 10,000 and 50,000 facts plus a
2,000-edge recursive-growth workload. It fails unless:

- rows and serialized proofs are byte-identical;
- median indexed wall-clock time is at least 2x faster; and
- deterministic relation work—index construction plus candidate visits—is reduced at
  least 100x.

The v0.17 development validation observed:

| Workload | Facts | Result rows | Scan median | Indexed median | Speedup | Relation-work reduction |
|---|---:|---:|---:|---:|---:|---:|
| Selective join | 10,000 | 100 | 39.65 ms | 5.59 ms | 7.09x | 188.72x |
| Selective join | 50,000 | 250 | 765.99 ms | 28.68 ms | 26.71x | 485.46x |
| Recursive growth | 2,000 | 2,000 | 146.10 ms | 5.18 ms | 28.20x | 572.16x |

Wall-clock values are machine-dependent; equality and deterministic work counters are
the portable evidence.

## Library diagnostics

Indexing is automatic. For parity checks or profiling only, library callers may pass:

```ts
const metrics = {
  relationLookups: 0,
  indexedRelationLookups: 0,
  indexFactsProcessed: 0,
  candidateFactsVisited: 0,
};

const rows = evaluate(clauses, query, {
  relationIndex: 'auto', // default; use 'off' only as a control
  metrics,
});
```

Each public evaluation call resets and fills the supplied metrics object. These counters
describe execution work, not stored knowledge, and do not affect limits or results.

## Deliberate boundary

Version 0.17 indexes only the first argument. It does not add a cost-based optimizer,
persist indexes beside `.dl` files, reorder goals, or guess which predicate positions are
identities. Additional positions or composite indexes require their own measured corpus
and the same byte-identical proof contract.
