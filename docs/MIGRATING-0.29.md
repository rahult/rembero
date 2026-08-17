# Migrating to 0.29

Version 0.29 changes only final no-match recall behavior. Facts, rules, constraints,
journals, snapshots, topology, graph, and successful recall formats require no migration.

API changes are additive except for the negative answer source:

- `ExplainWhyNotResult` adds required `summary`;
- `summarizeWhyNot(...)` and summary limit constants are exported;
- `RecallResult` / `RetrievalResult` may contain `whyNotUnavailable`; and
- final `no_match` recall now always contains either complete `whyNot` or typed
  `whyNotUnavailable`.

Previously, `recallQuestion(...)` sent empty bindings to the phrasing model and returned
its text. It now returns a deterministic local answer and performs two model calls at most
(initial query plus optional translation fallback), not three. Applications asserting
custom LLM wording for empty results should switch to the structured blocker summary.
