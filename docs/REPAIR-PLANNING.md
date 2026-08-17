# Verified deterministic repair planning

Rembero 0.27 can propose the smallest grounded fact changes it can prove would satisfy a
query. This is bounded abduction over the existing rule system, not an LLM suggestion and
not mutation authority.

## Use

```bash
rembero repair 'eligible(bob)'
rembero repair 'ready(bob)' --repair-steps 4 --plan-limit 8
rembero repair 'eligible(mira)' --entity-identity canonical
```

The library exposes `planKnowledgeRepair(store, query, options)`. MCP exposes
`plan_query_repair`. Every path captures one current namespace/source baseline under the
normal mutation boundary and returns its SHA-256 `baselineDigest`.

## Search contract

The planner starts with the complete v0.24 why-not tree and extracts only actionable,
grounded leaves:

- `missing_fact` can propose one ordinary ground fact assumption;
- `negated_fact_present` can propose retracting every exact target-namespace base fact
  blocking that grounded negation; and
- `rules_blocked` explores each rule alternative through its nested leaves.

Comparisons, aggregate-output mismatches, ungrounded missing facts, recursive cycles, and
derived blockers with no retractable base witness remain unresolved. The planner never
invents a value, rule, constraint, identity declaration, trust declaration, or metadata
mutation.

Search is iterative. After one proposal is applied in memory, the query is diagnosed
again, allowing a rule such as `ready(X) :- employee(X), badge(X), trained(X).` to reveal
`badge(bob)` first and `trained(bob)` next. A bounded uniform-cost frontier orders states
by actual fact-change count, so retracting four blockers costs four rather than one
diagnostic step. Alternative rules produce alternative plans.

## Verification and policy

Every candidate runs through the same v0.23 counterfactual engine. A plan is returned only
when the requested query has at least one complete proof at the minimum reachable change
count. The planner then removes each
edit whose removal still leaves the query satisfied and removes plans that are strict
supersets of another verified plan.

Each plan includes:

- canonical `assume` facts and exact `without` patterns;
- actual application results, including duplicates/unmatched retractions;
- candidate rows, proofs, hypothetical sources, and graph;
- result and complete integrity deltas;
- `strictIntegritySafe`, requiring zero candidate violations; and
- `noNewViolationsSafe`, requiring zero introduced violation identities.

Plans that introduce policy violations remain visible but explicitly unsafe. This lets a
human inspect why the query would succeed and why the proposed change should still be
rejected. Nothing is persisted, reserved, or authorized. Callers must compare the baseline
digest or run a fresh plan before any separately authorized write.

## Identity, trust, namespaces, and bounds

Canonical identity is used for diagnosis and proof. When a negated canonical fact comes
from an alias-projected literal base fact, the plan retracts that literal source rather
than a nonexistent projected clause. Tentative claims remain excluded by default;
`include_tentative` changes the diagnostic view but assumptions are still accepted fact
proposals, never trust assignments.

`namespace` is the one hypothetical mutation target and must be part of `namespaces`.
Facts supplied only by another selected namespace cannot be retracted through the target;
such a branch remains unresolved after verification.

Defaults and hard limits are:

- 8 returned plans, maximum 32;
- 4 iterative blocker steps, maximum 8;
- 128 inspected edit states, maximum 512;
- 64 assumptions/retractions inherited from counterfactual simulation; and
- existing why-not, proof, graph, integrity, namespace, input, and 16 MiB output limits.

If a depth, state, plan, diagnostic, or output limit prevents a complete minimal result,
the planner fails closed instead of returning a partial plan set.
