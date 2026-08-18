# Digest-bound reviewed rule change application

Remembero 0.44 closes the rule-review loop without making simulation itself authoritative.
`what-if` still only proposes and proves a change. A separate explicit apply operation
accepts that exact proposal after review, revalidates it under the global mutation lock,
and either commits the complete rule change atomically or writes nothing.

## Workflow

```bash
remembero what-if 'eligible(Person)' \
  --without-rule 'eligible(X) :- employee(X), badge(X).' \
  --assume-rule 'eligible(X) :- employee(X), badge(X), \\+ suspended(X).' \
  --check-suite checks.json > rule-review.json

remembero apply-rule-change rule-review.json --op-id eligibility-v2
```

The proposal can be either the standalone `ruleProposal` object or the complete `what-if`
JSON containing it. The library exposes `parseRuleChangeProposal(...)` and
`applyRuleChangeProposal(store, proposal, options)`. MCP exposes `apply_rule_change`.

This is mutation authority. Agents should not call it merely because a proposal exists;
the caller must deliberately select the reviewed artifact and operation ID.

## Proposal identity

The v1 proposal binds:

- target and complete governed namespace order;
- a SHA-256 digest of the exact ordered clauses in every selected namespace;
- exact canonical added and removed rules;
- the query used for consequence review;
- the normalized optional knowledge/coverage suite;
- identity/trust projection modes; and
- an optional recorded coordinate.

`proposalDigest` covers every field. Any edit, including changing the query or suite,
invalidates the artifact. Proposals generated from recorded history remain reviewable but
can never be applied to current knowledge.

## In-lock gates

Application owns the existing cross-process mutation lock, target namespace lock, and
journal lock while it:

1. resolves an idempotent replay or rejects operation-ID reuse with different content;
2. recomputes the complete current program digest and rejects a stale baseline;
3. requires every exact removal to exist and every addition to be absent after removal;
4. builds the entire multi-namespace candidate in memory;
5. materializes and audits the candidate rule program;
6. runs the attached knowledge checks and semantic coverage requirement, if present;
7. enforces `no_new_violations` over exactly the proposal namespaces; and
8. commits one crash-recoverable namespace replacement plus one append-only journal event.

Any parse, stratification, resource, audit, check, coverage, integrity, stale-digest, or
output failure occurs before the namespace file or journal changes.

## Durable result and replay

The journal records `rule_change` with the baseline/proposal digests, exact added and
removed rules, namespaces, operation ID, and reviewed-proposal source text. Recorded
snapshots, semantic diffs, bundles, checkpoints, and source lookup replay this operation.

The result includes its authoritative global journal `sequence`, exact additions and
removals, proposal/baseline digests, candidate rule audit, and attached suite result. A
retry with the same operation ID and proposal returns the same sequence and evidence;
reuse with different content returns `operation_conflict`.

## Error contract

- `rule_change_stale`: current selected clauses no longer match the reviewed baseline;
- `rule_change_checks_failed`: candidate checks or coverage do not pass;
- `integrity_violation`: candidate introduces a forbidden state;
- `operation_conflict`: the operation ID already belongs to another mutation; and
- ordinary validation errors: malformed/tampered proposal, recorded-only proposal,
  unsupported policy/metadata, or resource exhaustion.

The CLI uses exit `7` for stale proposals, `2` for check/coverage rejection, `3` for
integrity rejection, and `4` for operation conflicts.

Policy changes remain outside this path. Rules may derive knowledge, but only explicit raw
policy authoring changes what states are forbidden.
