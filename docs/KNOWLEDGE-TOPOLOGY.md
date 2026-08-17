# Deterministic knowledge topology

Rembero 0.25 exposes the structure of the selected personal knowledge program. Unlike a
query-scoped explanation graph, topology answers system questions: which predicates feed
a rule, which conclusions depend on a fact family, where negation raises the stratum,
which rules recurse, and which referenced inputs have no definition.

## Use

```bash
rembero topology
rembero topology colleague --direction upstream
rembero topology works_at/2 --direction downstream
rembero topology status --as-of-sequence 17
```

The library exposes `analyzeKnowledgeTopology(clauses, sources, options)`. MCP exposes
`knowledge_topology`. All paths are local, read-only, and deterministic; no LLM or graph
sidecar is involved.

Version 0.28 layers `audit-rules` / `audit_rules` over this graph, adding stable finding
nodes and evidence links while keeping topology itself descriptive rather than normative.

## Graph contract

Predicate nodes report:

- predicate name/arity and evaluation stratum;
- semantic fact and rule counts plus authored rule occurrence count;
- positive, negative, aggregate, and constraint reference counts;
- `openInput`, `derivedOnly`, and `recursive` classifications; and
- namespaces and operation count supplying definitions.

Rule nodes collapse alpha-equivalent definitions into one semantic node while retaining
every authored engine rule number and durable source. Constraint nodes use the same
stable identity as integrity inspection. Edges preserve authored body position:

- `defines`: rule to its head predicate;
- `requires`: positive body dependency; and
- `excludes`: closed-world negated dependency.

Every body edge on an aggregate rule is marked `aggregate: true`, because aggregation
creates a strict stratum dependency even when the individual goal is positive.
Comparisons remain visible as counts on their rule or policy node; they do not invent a
relation node.

## Recursion and open inputs

`recursiveComponents` are deterministic strongly connected predicate components,
including self-recursive predicates, with the authored rule numbers participating in the
cycle. Stratification has already rejected cycles through negation or aggregation, so a
reported recursive component is positive recursion.

`openInputs` are referenced predicates with no selected fact or rule definition.
`openNegatedInputs` is the important subset used under `\+`: closed-world evaluation will
treat those relations as empty. This is not automatically an error—an application may
intend to populate an input later—but it is now reviewable instead of silently implied.

## Focused influence

Focus accepts `predicate` when the name has one arity, or explicit `predicate/arity`.
Ambiguous and unknown names fail explicitly.

- `upstream` follows defining rules to every transitive requirement;
- `downstream` follows consuming rules to every transitive conclusion; and
- `both` unions the two closures.

Whenever a rule is selected, all its direct predicate nodes and edges remain present so
the graph never displays a partial rule. Policies touching selected predicates are also
included with all their direct dependencies. Selection metadata records original graph
sizes; counts in the result describe the selected graph.

## Views, provenance, and bounds

Current topology uses one mutation-locked clause/source snapshot. Exact recorded
topology uses the same global journal sequence as other historical reads. Canonical
identity and opt-in tentative trust are projected before analysis, so metadata predicates
never leak into the rule map and tentative facts remain hidden by default.

The operation fails closed above 100,000 semantic facts, 4,096 predicates, 4,096 authored
or semantic rules, 256 constraints, 32,768 edges, a 256-byte focus, existing namespace
and recorded-history limits, or the 16 MiB CLI/MCP output boundary. Duplicate facts and
alpha-equivalent rules across namespaces are semantic duplicates; their provenance is
retained rather than multiplying topology nodes.
