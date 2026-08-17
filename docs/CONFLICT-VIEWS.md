# Deterministic conflict views

Version 0.18 turns explicit integrity findings into focused, inspectable personal
knowledge views. It answers jobs such as:

```bash
rembero conflicts
rembero conflicts mira
rembero conflicts "'Mira Patel'" --entity-identity canonical
rembero conflicts mira --as-of-sequence 17
```

The MCP equivalent is `conflict_views`. No LLM is used.

## Authority boundary

Rembero still does not guess that two facts conflict. Only an explicit headless Datalog
constraint defines a forbidden state:

```prolog
:- status(Person, active), status(Person, terminated).
:- works_at(Person, Left), works_at(Person, Right), Left < Right.
```

Conflict views are a read-only projection over the selected `.dl` clauses and append-only
source journal. They do not persist a conflict table, graph database, subject schema, or
repair state.

## Focus contract

Each constraint already records its variables in alpha-stable first-appearance order.
Version 0.18 uses the first variable as that constraint's conflict focus. In both examples
above, the focus is `Person`.

This rule is deliberate:

- it survives variable renaming;
- it follows authored body and argument order;
- it never infers subject meaning from predicate names;
- constraints without variables enter one explicit `global` cluster.

If another value should define the focus, author the constraint so that variable appears
first. Every returned violation records `focusBinding`, making the decision inspectable.

An optional focus is exactly one ground Datalog atom or number. Ambiguous input,
variables, wildcards, multiple terms, or values above 4 KiB fail before evaluation. With
`entityIdentity: canonical`, an alias focus resolves through the same explicit identity
declarations used by the constraint view.

## Result shape

The result retains the complete underlying audit counts and adds:

- `focus`: the normalized requested focus, when supplied;
- `matchingViolationCount`: complete violations returned after the focus filter;
- `clusterCount` and ordered `clusters`;
- a stable content-derived cluster ID and serialized focus;
- every contributing constraint ID, clause, query, and declaration source;
- every violating row with its constraint row number, cluster-local `graphResultId`,
  proofs, and durable fact sources;
- the deterministic rule table and a focused evidence graph.

Each graph adds one `conflict` node. Ordered `contains` edges connect it to the violation
result rows, whose existing `answers`, `because`, `arg`, `proves`, aggregate, and absence
evidence remains unchanged. Existing result/support/neighborhood graph selectors apply to
each returned cluster. The cluster-local result IDs keep row selection unambiguous when
multiple constraints produce identical binding objects.

## Current and recorded views

CLI `--as-of-sequence` and MCP `recordedSequence` reconstruct the exact journal-position
snapshot before checking and grouping conflicts. The response includes the same
`recordedSnapshot` metadata as query, explanation, and integrity inspection.

Current conflict views observe only current base predicates unless a constraint explicitly
names `_until` history. This is the same temporal boundary as `check_integrity`.
Tentative claims are likewise excluded by default; `include_tentative` produces an
explicitly labeled pre-promotion conflict view.

## Completeness and exits

`maxViolations` bounds the complete audit before grouping. Exceeding it fails closed;
clusters are never silently truncated. Proof, graph, recorded-history, namespace, and
output limits are inherited from the existing deterministic surfaces.

The CLI exits `2` when the returned focus has one or more violations and `0` when it has
none. The global audit `status` and `violationCount` remain visible even when a requested
focus has no matching cluster.

Conflict views diagnose; they never repair automatically. Use explicit `supersede`,
`forget`, or `assert` operations—with integrity enforcement where appropriate—to make a
reviewable correction.
