# Migrating to Remembero 0.8

Remembero 0.8 adds opt-in bounded alternative-proof inspection. No memory, journal,
namespace, temporal-history, or SQLite migration is required.

## Backward compatibility

- `query`, `recall`, and ordinary evaluation are unchanged.
- `explain`, `explain_query`, `recall-explain`, and `recall_explain` still return the
  existing first deterministic witness by default.
- Existing explanation JSON and compact graph shapes remain unchanged at the default
  proof limit of one.
- The SQLite extension continues to expose one deterministic proof per result; alternative
  enumeration belongs to the portable personal-memory engine in v0.8.

## Opt in

CLI:

```bash
rembero explain 'path(a, X)' --proof-limit 4
rembero recall-explain "How can A reach X?" --proof-limit 4
```

MCP:

```json
{
  "name": "explain_query",
  "arguments": { "query": "path(a, X)", "proofLimit": 4 }
}
```

Library:

```ts
const result = explainKnowledge(clauses, 'path(a, X)', sources, {
  maxProofsPerRow: 4,
});
```

The primary proof remains in `rows[].proofs`. Additional complete witnesses appear in
`rows[].alternativeProofs`. Expanded sourced facts may include `sourceAlternatives`, and
the graph adds `proof` nodes plus `proves` edges only when structural alternatives exist.

## New failure cases

Expanded explanation is intentionally fail-closed. Callers should handle `EngineLimitError`
when a result has more proofs than requested or proof search exceeds its bounded work
budget. Increase `proofLimit` up to 16 for a larger complete set. Aggregate queries reject
limits above one because their existing contributor proofs already use a separate exact
completeness contract.
