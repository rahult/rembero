# Proposal-only deterministic rule change impact

Remembero 0.43 lets a rule author prove what a proposed program change would do before the
rule becomes authority. It extends the existing read-only counterfactual sandbox rather
than introducing a second evaluator or mutation path.

The result compares one immutable current or exact recorded baseline with one in-memory
candidate across query rows, derivation evidence, integrity policy, rule topology, rule
health findings, and an optional knowledge regression/semantic coverage suite. Nothing is
written, reserved, or implicitly approved.

## Use

```bash
rembero what-if 'colleague(mira, Who)' \
  --assume-rule 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'

rembero what-if 'eligible(Person)' \
  --without-rule 'eligible(X) :- employee(X), badge(X).' \
  --assume-rule 'eligible(X) :- employee(X), badge(X), \\+ suspended(X).' \
  --check-suite checks.json

rembero what-if 'derived(X)' \
  --assume-rule 'derived(X) :- base(X).' \
  --as-of-sequence 17
```

`--assume-rule` and `--without-rule` are repeatable. Removal is exact after canonical
alpha-renaming, so a request using `Person` removes an otherwise identical stored rule
using `X`; it cannot pattern-delete a family of rules.

The library uses `simulateKnowledge(store, query, options)` with `assumeRules`,
`withoutRules`, optional `checkSuite`, and optional `recordedSequence`. MCP `what_if`
exposes the same fields.

## Result evidence

The existing query and integrity result remains unchanged and gains rule-specific data:

- `application` lists exact assumed, duplicate, retracted, and unmatched rules separately
  from fact changes;
- `ruleAuditDelta.baseline` and `.candidate` contain complete deterministic rule audits
  and topology graphs over the same selected view;
- introduced/resolved findings are compared by stable finding identity;
- added, removed, and content-changed topology node/edge IDs expose structural program
  change even when a stable predicate identity remains;
- `checkDelta` runs the same JSON v1 knowledge suite on both programs, identifies checks
  that regressed or were fixed, and reports exact semantic coverage percentages plus
  coverage pass/fail regression; and
- query rows, proofs, sources, graphs, and integrity violations still receive their normal
  before/candidate delta.

Assumed rules receive deterministic in-memory sources with `hypothetical: true`. Their
topology nodes therefore show proposal provenance. The query proof continues to cite
stored supporting facts normally.

## Authority and recorded baselines

Rule simulation is proposal, never authority. It does not call `assert`, change a `.dl`
file, append the journal, rotate a checkpoint, update a cache, or create a persistent
source. It also does not reserve the baseline against a later writer.

An effective current-state preview includes a digest-bound `ruleProposal`. Version 0.44
adds a separate explicitly authorized apply operation that revalidates the artifact and
all gates under the mutation lock; simulation itself remains non-mutating. See
[reviewed rule change application](RULE-CHANGE-APPLICATION.md).

With `recordedSequence`, Remembero reconstructs the exact namespace view at that global
journal position, including per-namespace duplicate witnesses, then applies the proposed
rule only in memory. The result includes the recorded coordinate and never mixes later
facts or rules into either side.

## Safety and completeness

- Up to 64 ordinary or grouped-aggregate rules may be added and 64 exact rules removed.
- Facts, integrity constraints, and reserved identity/trust definitions are rejected from
  the rule fields. Existing fact-only `--assume`/`--without` remain separate.
- The complete candidate program must parse, range-check, stratify, terminate, satisfy
  evaluator/proof/aggregate bounds, and fit topology/audit limits. Invalid negative or
  aggregate cycles fail the whole preview.
- Knowledge suites retain their 1 MiB, 64-check, row, proof, and coverage bounds.
- Baseline and candidate integrity audits are independently complete or fail closed.
- CLI/MCP results retain the 16 MiB output boundary.

Policies are deliberately not authorable through this surface. A policy change has a
different authority boundary from a rule proposal and remains an explicit raw-program
operation followed by ordinary audit/enforcement review.
