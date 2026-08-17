# Migrating to 0.33

Version 0.33 is additive. Existing clauses, journals, checkpoints, snapshots, exports,
queries, graphs, and recall behavior require no migration.

New interfaces are:

- library: create/serialize/verify bundle functions, bundle artifact/view/verification
  types, format/version constants, and bundle resource limits;
- CLI: `bundle` and `verify-bundle <file>`; and
- MCP: `export_knowledge_bundle` and `verify_knowledge_bundle`.

The existing text `export` command is unchanged. Bundles are not an import format in v1:
verification proves structural/content integrity, not authorization to overwrite a store.
