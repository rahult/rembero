# Migrating to 0.36

Version 0.36 extends knowledge check suite JSON v1 additively. Existing suites without a
`coverage` field remain valid and never fail solely for uncovered rules.

Changes are:

- `KnowledgeCheckSuite.coverage` optionally accepts `minimumPercent` 0–100;
- every `KnowledgeCheckSuiteResult` adds `coveragePassed` and a semantic `coverage` report;
  and
- rule coverage result/entry/requirement types are exported.

CLI exit `2` now also covers a failed coverage threshold when every named check passed.
Consumers relying only on `failedCount` should additionally inspect `status` or
`coveragePassed`.
