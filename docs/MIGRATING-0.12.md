# Migrating to Remembero 0.12

Version 0.12 adds optional graph navigation. Existing `.dl` files, journals, queries,
explanations, recall, integrity checks, MCP clients, and SQLite extension behavior need
no migration. Without `graphSelector` or a graph CLI flag, outputs remain unchanged.

To reduce a large explanation payload, choose exactly one selector:

```bash
remembero explain 'ancestor(alice, Descendant)' --graph-result 2
remembero explain 'ancestor(alice, Descendant)' --graph-support '<node-id>'
remembero explain 'ancestor(alice, Descendant)' --graph-neighbors '<node-id>' --graph-depth 2
```

MCP and library callers use `{ kind: 'result', row }`, `{ kind: 'support', nodeId }`, or
`{ kind: 'neighbors', nodeId, depth? }`. Result rows are one-based. Neighborhood depth
defaults to 1 and cannot exceed 8.

Selection changes only the returned `graph`. Inspect `graphSelection` for the normalized
selector, resolved focus IDs, and original graph sizes. Do not infer that omitted nodes
or edges were absent from the full explanation.
