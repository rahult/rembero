# Migrating to 0.18

Version 0.18 is additive. Existing `.dl` files, journals, constraints, snapshots, CLI
commands, and MCP clients require no migration.

New read-only surfaces:

- library `inspectConflicts(clauses, sources, options)`;
- CLI `remembero conflicts [focus]`;
- MCP `conflict_views`.

The surfaces group complete integrity violations by each constraint's first alpha-stable
binding. Optional focus filtering, canonical entity identity, recorded sequences, proof
limits, violation limits, and graph selectors reuse existing contracts. Variable-free
constraints enter a global cluster.

New public types include `ConflictViewResult`, `ConflictCluster`, `ConflictViolation`,
`ConflictConstraint`, and `ConflictGraphNode`. The new `contains` graph edge links a
conflict cluster to its violation result rows.

No conflict state is stored, and no predicate is assumed to be exclusive without an
explicit constraint. See [the conflict-view contract](CONFLICT-VIEWS.md).
