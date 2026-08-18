# Query-scoped graph navigation

Remembero 0.12 can return a focused portion of an explanation graph while keeping the
portable Datalog store as the only authority. Selection is a pure projection over an
already bounded explanation: result rows, proofs, rules, sources, and stored clauses are
not filtered or mutated.

Three selectors are available:

- `{ kind: 'result', row: 2 }` returns the complete support closure for the second
  one-based result row. A row beyond the result set returns an honest empty graph.
- `{ kind: 'support', nodeId }` returns the selected node and its complete downstream
  support. Selecting a claim also retains every explicitly requested alternative proof.
- `{ kind: 'neighbors', nodeId, depth: 2 }` returns an undirected breadth-first
  neighborhood. Depth defaults to 1 and is capped at 8.

Unknown node IDs, invalid rows or depths, empty IDs, and IDs over 4096 UTF-8 bytes fail
closed. Selected nodes and edges retain the deterministic ordering of the full graph.
Every selected response includes `graphSelection` with the normalized selector, focus
node IDs, and original node/edge counts.

## Interfaces

The public library exports `selectExplanationGraph`, `selectKnowledgeGraph`, selector
types, and selector bounds. `explainKnowledge`, recall explanation, and integrity options
also accept `graphSelector` directly.

The CLI exposes `--graph-result`, `--graph-support`, `--graph-neighbors`, and
`--graph-depth`. The three selectors are mutually exclusive. Graph selection is valid on
`recall-explain`, `explain`, and `check`; on write commands it selects only integrity
rejection evidence and therefore requires active integrity enforcement.

MCP uses the matching `graphSelector` discriminated object on `recall_explain`,
`explain_query`, and `check_integrity`. Write tools accept it as an integrity option so a
rejected candidate can return focused evidence. Normal recall and query intentionally do
not expose graph options because they do not return graphs.

No selected graph is persisted. Re-run the same explanation over the same ordered
knowledge view to obtain the same selection.
