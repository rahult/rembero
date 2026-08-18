# Content-addressed portable knowledge bundles

Remembero 0.33 packages raw portable knowledge authority and durable provenance into one
deterministic JSON artifact. It fills the gap between clause-only text export and internal
journal checkpoints: bundles are standalone, namespace-aware, content-addressed, and
verifiable without opening or mutating a store.

## Use

```bash
rembero bundle > knowledge.json
rembero bundle --namespaces personal,work > selected.json
rembero bundle --as-of-sequence 17 > recorded-17.json
rembero verify-bundle knowledge.json
```

The library exposes `createKnowledgeBundle(...)`, `serializeKnowledgeBundle(...)`, and
`verifyKnowledgeBundle(...)`. MCP exposes `export_knowledge_bundle` and
`verify_knowledge_bundle`; export returns compact bundle JSON verbatim rather than wrapping
it in another JSON result.

## Format

Version 1 has:

```json
{
  "format": "rembero-knowledge-bundle",
  "version": 1,
  "view": { "kind": "current" },
  "namespaces": [
    {
      "namespace": "personal",
      "clauses": [
        {
          "clause": "pet(rahul, luna).",
          "sources": [
            {
              "namespace": "personal",
              "opId": "...",
              "ts": "2026-08-17T00:00:00.000Z",
              "text": "My cat is Luna."
            }
          ]
        }
      ]
    }
  ],
  "sha256": "..."
}
```

Recorded bundles use `{ "kind": "recorded", "sequence": n, "journalEntries": m }`.
The digest covers every field except `sha256` after canonical normalization.

## Raw authority

Bundles contain literal namespace clauses, not accepted/canonical projections. Explicit
`rembero_alias`, `rembero_entity_position`, and `rembero_tentative` declarations therefore
remain portable. The same canonical clause may appear in multiple namespaces with only
that namespace's sources.

Durable source fields include canonical timestamp, operation ID, redacted source text,
redaction marker, supersession lineage, and accept/reject trust action when present.
Hypothetical or identity-projected sources are rejected because they are read-view
evidence, not durable raw authority.

Current export captures one mutation-locked namespace/source snapshot. Recorded export
uses exact journal replay and current-file reconciliation. Immutable journal segmentation
does not affect bundle coordinates or content.

## Verification

Standalone verification rejects:

- malformed JSON, wrong format/version, unknown or missing fields;
- invalid, duplicate, or unsorted namespaces, clauses, and sources;
- non-canonical Datalog clauses or temporal previous clauses;
- invalid namespaces, operation IDs, ISO timestamps, temporal lineage, or trust actions;
- source namespaces that do not match their containing namespace;
- projected/hypothetical provenance and any unknown source field;
- resource-bound violations; and
- any SHA-256 mismatch.

Verification returns only the validated digest, view, namespace names/count, clause/source
counts, and canonical byte size. It never imports the artifact.

SHA-256 detects content changes; it is not a signature, sender identity, authorization
grant, or encryption. Authenticate and protect bundle transport separately.

## Determinism, privacy, and bounds

Ordering uses locale-independent bytewise string comparison. Serialization is compact
JSON with no creation timestamp, random ID, host path, or environment field, so identical
raw state and provenance produce identical bytes and digest.

Bundles contain personal clauses and source statements. Credential-like source text has
already been redacted by normal store ingress, but raw Datalog can contain sensitive
values and is exported exactly. Treat bundle files and MCP output as private data.

Hard limits are 16 MiB serialized bytes, 32 namespaces, 100,000 clauses, and 200,000
durable source records, in addition to normal snapshot and history completeness checks.
CLI verification refuses symbolic links and non-regular files.
