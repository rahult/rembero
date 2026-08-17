# Migrating to 0.27

Version 0.27 is additive. Existing facts, rules, constraints, journals, snapshots,
topology, why-not, counterfactual, diff, and recall behavior require no migration.

New interfaces are:

- counterfactual library: `captureCounterfactualBaseline(...)`,
  `applyCounterfactualChanges(...)`, `buildCounterfactualKnowledgeView(...)`, and
  `evaluateCounterfactualKnowledgeView(...)` plus their view types;
- repair library: `planKnowledgeRepair(...)`, result/plan/options types, and search limit
  constants;
- CLI: `repair <query>` plus `--plan-limit`, `--repair-steps`, and `--search-states`; and
- MCP: `plan_query_repair`.

The refactored counterfactual helpers preserve the v0.23 `simulateKnowledge(...)` result
shape. Repair results are new proposal objects and never invoke a writer. A baseline
digest is evidence of the captured input, not a durable operation ID or compare-and-swap
authorization token.
