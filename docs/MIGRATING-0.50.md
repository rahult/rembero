# Migrating to 0.50

Version 0.50 is additive and enforcement is off by default. Existing writes and stored
formats remain unchanged until configured.

New interfaces are:

- `MutationContext.checks` and `KnowledgeCheckEnforcementOptions`;
- `PipelineDeps` / `StoreToolDeps` default check enforcement;
- `enforceKnowledgeCheckCandidate(...)` and structured
  `KnowledgeCheckEnforcementError`; and
- `REMBERO_CHECK_MODE`, `REMBERO_CHECK_SUITE`, and `REMBERO_CHECK_NAMESPACES`.

Use `no_regressions` to adopt enforcement on a legacy failing suite, repair the baseline,
then switch to `strict`. CLI rejection exit code is `8`.
