# Migrating to 0.30

Version 0.30 is additive and keeps successful natural phrasing as the default. Existing
facts, rules, recall callers, prompts, journals, snapshots, proofs, and graphs require no
migration.

New interfaces are:

- `RecallAnswerMode`, `RecallOptions.answerMode`, `PipelineDeps.recallAnswerMode`, and
  optional `RecallResult.answerMode`;
- exported `deterministicRecallAnswer(...)`;
- CLI `--answer-mode natural|deterministic` for `serve`, `recall`, and `recall-explain`;
- MCP `answerMode` on `recall` and `recall_explain`; and
- environment `REMBERO_RECALL_ANSWER_MODE`.

`answerMode` is emitted in the result only when deterministic mode is active, preserving
the natural-mode response shape. Deterministic mode intentionally skips the final
successful-answer phrasing call, so test doubles and usage accounting should expect one
fewer model request.
