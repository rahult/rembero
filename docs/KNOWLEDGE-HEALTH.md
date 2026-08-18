# Immutable deterministic personal knowledge health

Remembero 0.48 provides one answer to “Is this knowledge base healthy?” without replacing
the underlying evidence tools. It captures one coherent current or exact recorded snapshot
and runs integrity, rule audit/topology, tentative review debt, identity metadata,
provenance completeness, and an optional knowledge/coverage suite over that same state.

No LLM is called and nothing is mutated.

## Use

```bash
rembero health
rembero health --namespaces personal,work
rembero health --check-suite checks.json
rembero health --as-of-sequence 17
```

The library exposes `inspectKnowledgeHealth(store, options)`. MCP exposes
`knowledge_health` with namespaces, recorded sequence, canonical identity, trust view,
optional serialized check suite, proof limit, and integrity row limit.

## Status

- `healthy`: no integrity violations, rule warnings, failing checks/coverage, pending
  tentative claims, or missing source witnesses.
- `review`: accepted reasoning remains policy-consistent, but deterministic maintenance
  debt exists.
- `violations`: one or more explicit integrity constraints are currently violated.

The CLI exits `0`, `2`, or `3` respectively and always prints the complete bounded report.

## Evidence components

The result contains the unchanged complete outputs of:

- `checkIntegrity`, including proofs, sources, and violation graph;
- `auditKnowledgeRules`, including topology, productivity, warnings/info, and graph;
- optional `runKnowledgeChecks`, including row regressions and semantic rule coverage;
- pending tentative facts decoded for review;
- validated canonical alias and entity-position declarations; and
- per-namespace durable source coverage.

Stable top-level findings summarize only actionable categories. They do not infer semantic
conflicts, confidence, ownership, or predicate meaning from names.

## Provenance completeness

Every current namespace/clause instance is matched to a durable source witness from the
same namespace. A clause manually added to a `.dl` file remains queryable—as designed—but
health reports `missing_provenance` instead of inventing when or why it appeared.

`sourceCoveragePercent` is based on clause instances, while `sourceWitnessCount` includes
corroborating witnesses across namespaces.

## Identity, trust, and time

Identity declarations are parsed and cycle/position validated even when canonical query
projection is not requested. Alias and position records retain their sources.

Tentative declarations remain outside accepted reasoning by default but always contribute
review debt. Opting into tentative reasoning changes integrity/rule/check evidence without
hiding the pending-review count.

Recorded health reconstructs the exact journal position and reports its sequence and total
journal length. Later violations, rules, tentative claims, and sources cannot leak backward.

## State identity and bounds

`stateDigest` covers ordered namespace clause identities and the complete ordered durable
source index, so provenance-only changes alter the health identity.

Existing integrity, proof, topology, audit, check, trust, identity, namespace, recorded,
and 16 MiB output limits apply. Health additionally caps stable findings at 4,096 and
unsourced clause details at 1,000; overflow fails rather than truncating a supposedly
complete report.
