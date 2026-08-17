# Migrating to 0.45

Version 0.45 is additive. Existing `remember`, tentative review, memories, rules, journals,
and stored formats are unchanged.

New interfaces are:

- library `extractRememberText(...)` for validated non-mutating model extraction;
- library `proposeRememberText(...)` and memory proposal/result types;
- CLI `propose-memory <text>`; and
- MCP `propose_memory`.

Proposal-first extraction always targets accepted knowledge and performs no mutation.
Existing callers that require tentative uncertainty should retain the established
tentative claim review workflow.
