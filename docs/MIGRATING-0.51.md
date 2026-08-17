# Migrating to 0.51

Version 0.51 is additive. Natural phrasing remains the default and deterministic binding
mode is unchanged.

`RecallAnswerMode` adds `evidence`. CLI/MCP/env validation accepts it, and positive results
include the existing `explanation` object because local rendering consumes that evidence.
No stored format changes are required.
