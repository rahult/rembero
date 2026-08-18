# Migrating to Remembero 0.11

Version 0.11 adds explicit entity identity as an opt-in read projection. Existing `.dl`
files, journals, history, literal queries, recall, integrity checks, and graphs require
no migration. The default remains identity `off`.

To adopt it:

1. Add raw `rembero_alias(Alias, Canonical).` facts.
2. Add `rembero_entity_position(Predicate, Arity, ZeroBasedPosition).` only where atoms
   represent entity identifiers.
3. Inspect declarations with `remembero list`.
4. Test reads with `--entity-identity canonical` before setting
   `REMBERO_ENTITY_IDENTITY=canonical` for a process.
5. If policy should treat aliases as one subject, run `check --entity-identity canonical`
   before enabling identity-aware write enforcement.

Do not rewrite stored facts as part of the upgrade. Canonical proof sources identify the
exact literal source clause, and history deliberately continues to match literal values.

New public APIs include `EntityResolver`, `buildEntityResolver`,
`canonicalizeKnowledge`, `literalKnowledge`, `EntityIdentityError`, and the entity
identity declaration and evidence types. Recall, explanation, integrity, enforcement,
CLI, and MCP option objects add the optional canonical mode.

The SQLite extension rejects the reserved identity declarations in 0.11 rather than
silently applying different semantics.
