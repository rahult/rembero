# Reviewable knowledge trust

Version 0.21 separates a claim being stored from that claim being accepted as knowledge.
This supports jobs such as:

- “Remember this as tentative until I confirm it.”
- “Show me the claims awaiting review.”
- “Use tentative evidence for this investigation, but do not treat it as accepted truth.”
- “Accept or reject this claim without erasing how the decision happened.”

Trust is explicit and binary: `accepted` or `tentative`. Remembero does not assign hidden
confidence scores, probabilities, or model-derived authority.

## Portable authority

Accepted facts retain the existing ordinary Datalog representation. A tentative fact is
stored in the same namespace `.dl` file as one reserved declaration:

```prolog
rembero_tentative('works_at(mira, acme).').
```

The encoded value must parse as exactly one bounded ordinary ground fact. Rules,
constraints, identity declarations, nested tentative declarations, variables, and
wildcards are rejected. The representation remains readable, exportable, hashable,
journaled, and reconstructable without a trust sidecar.

`rembero_tentative` is metadata, not an executable predicate. It cannot appear in rule or
constraint bodies, natural-language extraction cannot author it directly, and the SQLite
adapter rejects it as personal-store metadata.

Generic store assertion, retraction, replacement, supersession, CLI/MCP raw-write tools,
and valid-time archiving cannot mutate trust metadata. Typed tentative operations own
that authority. Portable export/import remains available through the validating
`importClauses` path.

## Read boundary

Every query, recall, explanation, integrity, conflict, list, canonical-identity, and
recorded-snapshot read defaults to `accepted`. Tentative declarations are validated but
removed before reasoning.

Callers must explicitly request `include_tentative` to project encoded claims into the
logical view:

```bash
remembero query 'works_at(mira, Company)' --trust include_tentative
remembero recall-explain 'Where might Mira work?' --trust include_tentative
remembero check --trust include_tentative
```

Opt-in results include `trustMode: "include_tentative"`. Tentative proof leaves, durable
sources, proof nodes, and claim graph nodes carry `trust: "tentative"` plus the exact
stored declaration in `projectedFrom`. Recall also returns per-row `rowTrust` and sends
that exact accepted/tentative classification to answer phrasing, so an accepted duplicate
is not incorrectly qualified merely because the broader view permits tentative claims.

If an accepted and tentative declaration encode the same fact, the accepted source stays
authoritative. Expanded source inspection may show the tentative declaration as an
alternative; it never downgrades the accepted proof.

## Write and review workflow

Raw CLI:

```bash
remembero assert 'works_at(mira, acme).' --trust tentative --op-id claim-17
remembero claims
remembero accept 'works_at(mira, acme).' --op-id review-17
remembero reject 'works_at(mira, acme).' --op-id review-18
```

MCP exposes `assert_tentative`, `review_tentative`, and `resolve_tentative`. The library
exposes `MemoryStore.assertTentative`, `MemoryStore.resolveTentative`, and the typed trust
helpers.

Acceptance atomically removes every exact tentative declaration and adds its decoded
ordinary fact. Rejection atomically removes the declarations without adding facts. Every
requested claim must still be current; partial batch resolution fails before mutation.
Duplicate requests fail. Explicit operation IDs replay the first result and reject
mismatched reuse.

Manual natural-language `remember` accepts `trust: "tentative"`. The caller—not the
model—assigns that state, and tentative remember is additive: it cannot retract accepted
knowledge. Existing ambient auto-capture remains limited to high-confidence user-grounded
facts and its separate review/prune contract; v0.21 does not silently change old capture
semantics.

## Integrity and transitions

Tentative assertion does not affect default integrity enforcement because tentative facts
are outside the accepted candidate view. Promotion is an accepted mutation and must pass
the configured strict or migration-mode policy atomically. An explicit
`include_tentative` audit or conflict view can inspect what would conflict before
promotion.

Trust transitions use the existing crash-recoverable replacement transaction. The journal
records `trustAction: "accept"` or `"reject"`, exact ended declarations, prior source
operation IDs, and accepted additions. Accepted proof sources and history events expose
the trust action.

Recorded snapshots contain the declarations or accepted facts active at that exact global
sequence. The same snapshot returns no tentative result under the default view and the
proof-labeled result under `include_tentative`; later promotion cannot rewrite that past.

## Bounds and security

- One tentative assertion accepts at most 64 facts.
- Each encoded fact is at most 16 KiB and the ordinary ingress/output bounds still apply.
- Review returns at most 1,000 claims across at most 32 namespaces.
- External-LLM schema and evidence secret checks run after trust projection; tentative
  secrets are never exported merely because they are stored.
- Trust metadata is validated even when excluded, so malformed declarations fail closed.
- No probabilistic rank, trust database, hidden review state, or persisted graph is added.
