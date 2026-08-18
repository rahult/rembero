# Semantic rule coverage

Remembero 0.36 derives rule coverage from the proof trees produced while running v0.35
knowledge checks. Coverage measures exercised rule meaning, not line execution or source
text occurrence.

## Enable a threshold

```json
{
  "version": 1,
  "coverage": { "minimumPercent": 80 },
  "checks": [
    {
      "name": "colleague derivation",
      "query": "colleague(rahul, mira)",
      "expect": { "kind": "nonempty" }
    }
  ]
}
```

`minimumPercent` is an integer from 0 through 100. Coverage is always calculated and
returned; the field only turns it into a suite gate.

## Semantic identity

Rules are parsed and grouped by alpha-normalized canonical key. Definitions such as
`copy(X) :- value(X).` and `copy(Y) :- value(Y).` therefore form one coverage unit with
both authored engine rule numbers. Any proof using either number covers the group.

Coverage traversal inspects:

- primary result proofs;
- alternative proof vectors requested through `proofLimit`;
- nested `because` derivations, including recursion; and
- aggregate derivations and every contributor proof.

Any actual proof counts, even when that check later fails its expected rows; coverage asks
what executed, while check status asks whether the result was correct.

Source records, graph nodes, and identity rewrite metadata do not create false rule hits.

## Report

Every suite result includes:

```json
{
  "coveragePassed": true,
  "coverage": {
    "totalRules": 4,
    "coveredRules": 3,
    "uncoveredRules": 1,
    "percent": 75,
    "minimumPercent": 75,
    "passed": true,
    "rules": [
      {
        "id": "rule:...",
        "clause": "copy(X) :- value(X).",
        "numbers": [1, 2],
        "checkNames": ["copy derivation"],
        "covered": true
      }
    ]
  }
}
```

Percent is rounded deterministically to two decimals. A program with no ordinary rules is
100% covered.

A threshold can fail the overall suite while `failedCount` remains zero because every row
expectation passed. CLI still exits `2`; callers should inspect `coveragePassed` separately
from check failures.

## Scope

Coverage describes the selected current or recorded, identity/trust-projected program.
Integrity constraints are policy checks, not ordinary rule coverage units. Use
`audit-rules` and `check` for structural and policy inspection.

Coverage does not prove all data paths, comparisons, bindings, or absence conditions were
tested. It proves only that at least one returned proof exercised each covered semantic
rule group.
