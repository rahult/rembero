# Migrating to 0.24

Version 0.24 is additive. Existing facts, rules, constraints, queries, snapshots,
journals, checkpoints, trust state, and successful recall/explanation responses require
no migration.

New interfaces are:

- engine: proof-free `materialize(...)` and engine-identical `comparisonMatches(...)`;
- library: `explainWhyNot(...)`, result/tree/graph types, and diagnostic limit constants;
- CLI: `why-not <query>` plus four optional diagnostic limits;
- MCP: `why_not`; and
- `recall-explain`: optional `whyNot` on a final empty, validated query.

`RecallResult` and `RetrievalResult` therefore gain the additive optional `whyNot` field.
Consumers that reject unknown properties should allow it before upgrading. Ordinary
`recall` does not calculate or return the diagnostic unless explanation was requested.

Why-not supports current and exact `--as-of-sequence` views. It does not accept graph
selectors because its blocker graph and each nearby fact's proof graph have different
node domains; callers receive both complete bounded graphs explicitly.
