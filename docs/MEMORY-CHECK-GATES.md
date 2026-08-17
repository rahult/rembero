# Regression-gated reviewed personal memory

Rembero 0.49 lets an accepted-memory proposal bind the same portable knowledge checks and
semantic rule coverage used in CI and reviewed rule changes. The suite is evaluated during
preview and must pass again on the exact in-lock candidate before `memory_change` commits.

## Use

```bash
rembero propose-memory 'Mira now works at Initech.' \
  --check-suite checks.json > memory-review.json

rembero apply-memory memory-review.json --op-id mira-work-v2
```

MCP `propose_memory` accepts serialized `checkSuite`; `apply_memory_proposal` reads the
normalized suite from the reviewed proposal. The library uses `checkSuite` in
`ProposeRememberOptions`.

## Preview evidence

Proposal generation runs the suite against both the captured baseline and candidate.
`checkDelta` reports complete results, fixed/regressed check names, semantic coverage
before/after, percentage movement, and coverage pass/fail regression.

The normalized JSON v1 suite is embedded in the proposal and covered by `proposalDigest`.
Changing a query, expected row, order mode, name, or coverage threshold invalidates the
artifact.

## Apply gate

Application parses the bound suite and runs it on the complete candidate while holding the
global mutation lock. A failed row expectation or coverage threshold raises
`memory_change_checks_failed`; no namespace file, journal event, source, or cache changes.

After commit, the result reconstructs the exact journal sequence and returns the same
suite result with durable sources. Idempotent replay returns evidence for that original
sequence rather than whatever state exists later.

The check gate composes with mandatory proposal/current digests, candidate rule audit,
and `no_new_violations` integrity enforcement. Passing checks cannot weaken another gate.

Suites retain the 1 MiB, 64-check, expected-row, proof, aggregation, and semantic coverage
bounds. The suite proves only its authored expectations; human review still controls the
meaning and accepted-memory transition.
