# Migrating to Rembero 0.9

Rembero 0.9 is storage-compatible with 0.8. Existing facts, rules, journals, histories,
recall behavior, proof ordering, and query-scoped graphs require no migration.

## Additive language syntax

Programs may now contain explicit headless integrity constraints:

```prolog
:- active(Person), suspended(Person).
```

They round-trip through `parseProgram`, `serializeClause`, store files, import/export, and
journaling. The exported `isIntegrityConstraint(clause)` discriminator separates them
from ordinary facts and rules. `OrdinaryClause` and `IntegrityConstraintClause` are also
exported for typed consumers; the existing `Clause` union remains the public program
element type and retains `head` and `body` on both variants for compatibility.

Constraints are inert during `evaluate`, proof evaluation, materialization, and
stratification. Existing rule ordinals and default outputs therefore remain unchanged.

## New APIs and tools

- Library: `checkIntegrity(clauses, sourceIndex?, options?)`
- CLI: `rembero assert <datalog>` and `rembero check`
- MCP: `check_integrity`; `assert_facts` also accepts constraints
- Listing: `list_memories` adds `constraints` only when declarations exist

`checkIntegrity` returns `unconstrained`, `consistent`, or `violations`, with grouped
proof/source/graph evidence. The new options are `maxViolations` and the existing proof
bounds, including `maxProofsPerRow`.

The CLI exits `2` for a successfully completed audit that found violations. Scripts that
call `rembero check` should treat exit `2` as an integrity finding rather than an
execution failure.

## Trust boundary

Natural-language `remember` and auto-capture cannot create integrity policy. Declare
constraints only through raw local Datalog (`rembero assert`, MCP `assert_facts`, import,
or direct library/store use). Checking is read-only in 0.9; writes are not automatically
rejected or repaired.

See [INTEGRITY-CONSTRAINTS.md](INTEGRITY-CONSTRAINTS.md) for namespace, temporal,
determinism, completeness, and evidence semantics.
