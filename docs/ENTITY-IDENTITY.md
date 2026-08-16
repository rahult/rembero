# Explicit entity identity

Rembero 0.11 adds an opt-in canonical read model for names that refer to the same
entity. It does not guess identity from spelling, embeddings, or predicate names.
Portable Datalog declarations define both aliases and the exact argument positions where
identity has meaning:

```prolog
rembero_alias('Mira Patel', mira_patel).
rembero_alias(mira_patel, mira).
rembero_entity_position(works_at, 2, 0).

works_at('Mira Patel', acme).
```

Positions are zero-based. With canonical identity enabled, both
`works_at(mira, Company)` and `works_at('Mira Patel', Company)` return `acme`.
Without it, ordinary literal Datalog behavior is unchanged.

## Why positions are explicit

Datalog atoms are untyped. Globally replacing every `mira_patel` atom could corrupt an
unrelated enum, tag, status, or organization code. `rembero_entity_position/3` therefore
limits projection to one predicate, arity, and argument position. A declaration for a
base predicate also covers the same position in its `_until` temporal companion.

Rules, constraints, query constants, facts, and proof claims are projected only at
declared positions. Comparisons are not rewritten because they have no predicate-position
context.

## Enabling the projection

The default is `off`. Enable it for a CLI process:

```bash
export REMBERO_ENTITY_IDENTITY=canonical
rembero query 'works_at(mira, Company)'
```

Or enable a single CLI read with `--entity-identity canonical`. Library recall options
and the raw query, explain, and integrity APIs accept `entityIdentity: 'canonical'`.
The corresponding MCP tools accept the same `entityIdentity` field. An environment
default can be disabled for one CLI call with `--entity-identity off`.

Identity-aware integrity enforcement is also explicit. Combine `canonical` identity with
`strict` or `no_new_violations` when aliases must denote one policy subject.

## Authority and provenance

- `.dl` files remain literal. Assertions, retractions, imports, exports, and journal
  events are never rewritten.
- `history` remains literal so its output exactly describes durable mutations.
- Canonical projections are ephemeral and deterministic; no alias index, vector store,
  or graph database becomes a second authority.
- When a proof uses a projected fact, the proof and graph claim include `projectedFrom`
  and bounded `identityRewrites` metadata even without a journal source. Durable sources
  carry the same evidence when available. An exact literal canonical source outranks a
  projected alias source. Projected rules and integrity declarations expose the same
  metadata. The query-scoped graph also annotates canonical entity nodes with the
  contributing alias declarations and their sources.
- `list` hides reserved declarations from ordinary predicate groups and returns them as
  `aliases` and `entityPositions` discovery metadata. If metadata is invalid, literal
  facts remain listable and the result includes an explicit `identityError` instead.

Natural-language `remember` and ambient capture may read a canonical schema view but
cannot create, modify, or retract identity declarations. Raw local Datalog remains the
only authority for this metadata.

## Validation and limits

Canonical reads fail closed when an alias has conflicting targets, a chain contains a
cycle or self-loop, a declaration is malformed, or reserved metadata appears in a rule
or constraint body. Literal reads do not interpret invalid identity metadata and retain
pre-0.11 behavior. A view accepts at most 10,000 alias declarations and 1,024 position
declarations.

The experimental SQLite extension rejects identity declarations explicitly until it can
provide the same position-scoped semantics and provenance contract.
