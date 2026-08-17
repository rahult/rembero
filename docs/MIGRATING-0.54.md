# Migrating to 0.54

Version 0.54 adds evaluation surfaces and does not change the runtime memory format or
existing CLI, MCP, TypeScript, SQLite, or web contracts.

New commands:

```bash
npm run bench:memory
npm run bench:memory:check
```

The existing recall scorer now preserves the semantic order of values inside a
multi-column row. Earlier releases sorted those values before comparison, which could let
role-reversed rows compare equal. Single-column scores and row-order normalization are
unchanged.

The external benchmark adapter protocol is versioned as `rembero.memory-stack.v1`. It is
an evaluation process boundary, not a runtime plugin API.
