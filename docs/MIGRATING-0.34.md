# Migrating to 0.34

Version 0.34 is additive. Existing facts, sources, prompts, queries, bindings, answers,
graphs, and stored formats require no migration.

Changes are:

- `RecallSchemaOptions.sourceIndex` accepts a local-only durable source map;
- `RecallSchemaDiagnostics` / `RecallSchemaSelection` add
  `sourceMatchedPredicates`; and
- `MAX_RECALL_SOURCE_RANKING_CHARS` is exported.

The recall pipeline now supplies its projected source map automatically. Direct callers
that omit `sourceIndex` retain clause-only ranking and receive an empty diagnostics field.
