# Portable deterministic knowledge checks

Remembero 0.35 adds executable regression suites for facts and rules. Suites are standalone
JSON, never stored in the knowledge base, and run without an LLM or mutation.

## Format

```json
{
  "version": 1,
  "checks": [
    {
      "name": "available employee",
      "query": "available(X)",
      "expect": { "kind": "nonempty" }
    },
    {
      "name": "no missing assignment",
      "query": "missing_assignment(X)",
      "expect": { "kind": "empty" }
    },
    {
      "name": "team members",
      "query": "member(red, Person)",
      "expect": {
        "kind": "rows",
        "order": "set",
        "rows": [{ "Person": "alice" }, { "Person": "bob" }]
      }
    }
  ]
}
```

Binding values are the same canonical serialized strings returned by query surfaces.
`exact` compares deterministic row order; `set` sorts both sides by canonical binding key
and rejects duplicate expected rows.

Version 0.36 optionally adds top-level
`"coverage": { "minimumPercent": 80 }`. Every run reports semantic rule coverage even
without a threshold; see [semantic rule coverage](RULE-COVERAGE.md).

## Run

```bash
remembero test-knowledge checks.json
remembero test-knowledge checks.json --as-of-sequence 17
remembero test-knowledge checks.json --include-passing-evidence
```

The library exposes `parseKnowledgeCheckSuite(...)` and `runKnowledgeChecks(...)`. MCP
exposes `run_knowledge_checks` with serialized suite JSON. CLI exit `0` means every check
passed; exit `2` means the complete suite ran and one or more expectations failed.

## Evidence

Passing checks return normalized actual rows and stay compact by default. Optional passing
evidence includes the normal explanation, sources, rules, and graph.

Failures always include:

- normalized actual rows;
- missing and unexpected rows for row/empty expectations;
- `orderMismatch: true` when exact rows contain the same multiset in another order; and
- ordinary explanation evidence when rows exist.

When a check expected rows but the query is empty, the failure also includes the complete
why-not tree, nearby sourced facts, blocker graph, and deterministic summary.

## Views, authority, and bounds

Suites run over one caller-selected current or exact recorded clause/source view. Canonical
identity, `include_tentative`, and proof limits match ordinary explanation semantics.
Checks cannot write, enforce policy, accept trust, apply repairs, or become namespace
authority.

Hard limits are 1 MiB suite JSON, 64 checks, 128-byte UTF-8 names, 64 bindings per expected
row, 10,000 expected rows across the suite, 64 KiB per query, existing evaluator/proof/
why-not/namespace/history limits, and the 16 MiB CLI/MCP output boundary. Suite structure,
field sets, names, row values, duplicate names/sets, and all bounds are validated before
the first query executes.
