# Deterministic rule health audit

Rembero 0.28 audits a selected rule program before a user has to discover its structural
or current-data hazards through a failed query. The audit is derived from v0.25 topology
and the same bounded fixpoint used by query evaluation. It does not guess domain intent or
rewrite valid Datalog.

Use v0.35 `test-knowledge` when a structural audit should be complemented by concrete
query/result regression expectations.

## Use

```bash
rembero audit-rules
rembero audit-rules eligible --direction upstream
rembero audit-rules status --as-of-sequence 17
```

The library exposes `auditKnowledgeRules(clauses, sources, options)`. MCP exposes
`audit_rules`. The CLI exits `2` when warnings require review and `0` for clean or
informational-only results.

## Warning findings

- `open_negated_input`: an undefined predicate is used under `\+`, so every grounded
  absence check currently succeeds under closed-world semantics;
- `policy_open_input`: an integrity-policy goal references a predicate with no selected
  fact or rule definition; and
- `unseeded_recursion`: a positive recursive component currently materializes no facts.

These are review signals, not parser errors. An application may intentionally populate an
open relation later, and a recursive rule may be waiting for future seed data.

## Informational findings

- `open_positive_input`: a positive dependency has no selected definition;
- `inactive_derived_predicate`: a non-recursive rule-defined predicate currently derives
  no facts;
- `duplicate_semantic_rule`: alpha-equivalent rules occur at multiple authored engine
  positions, with provenance retained on their one semantic topology node; and
- `predicate_arity_overload`: one name appears with multiple arities, so callers and
  generated queries should use explicit signatures.

The audit deliberately does not flag fact-only predicates as unused, rule outputs as
dead, or clean constraints as ineffective: each may be an intentional public query or
policy surface.

## Evidence graph and focus

Each finding has a stable content-derived ID, severity, code, exact predicate keys,
related rule/policy IDs, and current materialized count when relevant. The result graph
contains the selected topology plus `finding` nodes and `flags` edges to every related
predicate, rule, or constraint.

Topology focus semantics are unchanged: `upstream`, `downstream`, or `both` retain whole
rule and relevant policy nodes. Findings are computed only for that complete selected
graph, so an unrelated hazard cannot leak into a focused audit.

## Views and bounds

Current audit uses one mutation-locked clause/source snapshot. Recorded audit uses exact
journal sequence replay. Canonical identity and opt-in tentative trust are projected
before topology and fixpoint analysis; reserved metadata does not become a rule node.

The audit fails closed above 4,096 findings, and inherits the evaluator's fact/iteration
limits, topology's 100,000-fact/4,096-predicate/4,096-rule/256-policy/32,768-edge limits,
recorded-history and namespace limits, and the 16 MiB CLI/MCP output boundary.
