# Migrating to 0.39

Version 0.39 is additive. Existing memories, rules, proofs, graphs, queries, and stored
formats require no migration.

Recall schema ranking now treats inverse grandparent/grandchild wording as one local
kinship concept. This can move an existing `grandparent` rule into the bounded detailed
schema slice for a grandchild question; accepted queries still evaluate against the same
complete knowledge view.

The grounded prompt also tells compatible models to query a matching derived-rule head
instead of inlining its body and exposing helper variables as answer columns.

No environment variable changes are required. `openai/gpt-5.6-luna` remains the default;
see `docs/MODEL-COMPATIBILITY.md` before selecting another `LLM_MODEL`.
