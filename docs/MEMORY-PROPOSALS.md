# Proposal-first accepted personal memory

Rembero 0.45 separates natural-language extraction from accepted-memory mutation. It uses
the identical model prompt, retry, parser, secret rejection, identity/trust restriction,
rule validation, and retraction validation as `remember`, but returns a review artifact
and never calls a store writer.

The existing direct `remember` API remains compatible. Proposal-first use is for people
and agents that want model extraction to remain proposal rather than authority.

## Use

```bash
rembero propose-memory 'Mira now works at Initech.'
rembero propose-memory 'Mira now works at Initech.' \
  --valid-time-mode archive_until --at '2026-08-17T07:30:00.000Z'
```

The library exposes `proposeRememberText(deps, text, namespace, options)`. MCP exposes
`propose_memory` with target/governed namespaces, valid-time mode, optional canonical UTC
instant, integrity evidence bounds, and canonical identity view.

## Deterministic review evidence

After the LLM response is locally validated, Rembero captures one coherent current
baseline. A concurrent write during the model call therefore becomes part of the proposal
baseline rather than creating immediately stale evidence.

The exact extraction is applied only to immutable arrays through the existing
counterfactual engine. The result includes:

- raw validated extracted clauses and retraction patterns;
- exact effective additions, duplicates, removals, and unmatched removals;
- candidate integrity results with introduced/resolved violation identities;
- full rule-audit/topology impact when text proposes a general rule; and
- a SHA-256 content-addressed proposal only when the effective candidate changes.

## Proposal identity

The proposal binds version, exact ordered multi-namespace program digest, target and
governed namespaces, original source text, valid-time policy and instant, exact added and
removed clauses, and identity projection mode. `proposalDigest` covers every field.

The artifact contains personal source text and should be protected like the memory store.
Any edit invalidates its digest.

## Corrections and time

Model retraction patterns are expanded against the captured baseline. The proposal stores
the exact facts actually removed, never a wildcard that could match future knowledge.

With `archive_until`, the proposal time is fixed at generation and every exact removal
also produces the corresponding system-managed `_until` fact. Candidate integrity and
rule impact therefore see the temporal clauses a later reviewed application would.

## Trust and authority

Proposal-first extraction targets accepted knowledge because human review is the authority
transition. The accepted extraction prompt skips hedged “may/might/maybe” claims. For
uncertain knowledge, continue using `remember --trust tentative` and the existing
`claims`/`accept`/`reject` lifecycle.

Version 0.45 itself does not apply memory proposals. Version 0.46 adds a separate explicit
digest-bound application boundary; proposal generation remains non-mutating. See
[reviewed personal memory application](MEMORY-APPLICATION.md).

Secrets still fail locally before any LLM request or proposal artifact. Policy and
identity metadata remain explicitly authored authority and cannot be extracted.
