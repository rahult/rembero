# All-writer knowledge check enforcement

Rembero 0.50 promotes portable knowledge checks and semantic rule coverage from explicit
review gates into an optional store-wide write invariant. Every supported writer reaches
the same `MemoryStore.enforceMutation` hook, so enforcement cannot depend on whether a
change came from raw Datalog, natural language, ambient capture, trust review, temporal
replacement, or a reviewed proposal.

## Configuration

```bash
export REMBERO_CHECK_MODE=strict
export REMBERO_CHECK_SUITE=/absolute/path/to/checks.json
export REMBERO_CHECK_NAMESPACES=personal,work
```

`REMBERO_CHECK_NAMESPACES=*` governs every current namespace. Relative suite paths resolve
from the process working directory. The file must be regular, non-symlinked, valid JSON v1,
and at most 1 MiB.

Programmatic callers set `MutationContext.checks`, `PipelineDeps.knowledgeCheckEnforcement`,
or `StoreToolDeps.knowledgeCheckEnforcement`. MCP servers inherit the programmatic or
environment default. CLI writes inherit the environment default.

## Modes

### `strict`

The complete candidate suite—including semantic coverage threshold—must pass. This is the
right mode once a knowledge base has a green baseline.

### `no_regressions`

Existing failing checks may remain and repairs may improve them. A write is rejected only
when:

- a previously passing named check fails;
- semantic coverage percentage decreases; or
- a previously passing coverage requirement becomes failing.

This supports adoption on legacy knowledge without accepting new deterministic debt.

## Atomic evidence boundary

While holding the global mutation lock, Rembero builds complete baseline and candidate
clause/source views for the configured namespaces. New clauses receive their prospective
source and temporal metadata before checks run. Both views use the ordinary proof engine,
identity/trust projection, aggregation, and coverage semantics.

A blocked write raises `knowledge_check_enforcement` with complete baseline/candidate
results, regressed/fixed names, and coverage movement. No namespace, journal, source,
checkpoint, or cache change occurs. CLI exits `8`; MCP returns the structured error.

## Writer coverage

The guard applies to:

- raw assert/import and exact forget;
- supersession and valid-time archives;
- direct natural-language remember;
- ambient transcript capture and reviewed capture pruning;
- tentative assertion, acceptance, and rejection;
- reviewed memory proposal application; and
- reviewed rule proposal application.

Tentative assertions normally leave accepted-view checks unchanged. Promotion can be
rejected when it would make an accepted check fail.

## Composition and limits

Check enforcement runs in addition to integrity enforcement. Passing either gate cannot
weaken the other. Each may govern a different explicit namespace union; both views are
constructed from the same locked candidate.

The suite retains all portable check, row, proof, aggregate, coverage, input, and output
bounds. Incomplete evidence aborts the write rather than being treated as a pass.
