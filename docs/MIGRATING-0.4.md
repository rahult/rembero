# Migrating to Remembero 0.4

Version 0.4 adds filter-only arithmetic expressions to portable-engine comparisons. The
existing parser, evaluator, query-spec, proof, CLI, MCP, and knowledge-graph entry points
remain in place.

## Comparison operand types

`Comparison.left` and `Comparison.right` widen from `Term` to `ScalarExpression`:

```ts
type ScalarExpression =
  | Term
  | UnaryArithmeticExpression
  | BinaryArithmeticExpression;
```

Code that previously passed comparison operands directly to a term-only visitor should
first use `isArithmeticExpression` and recurse through `operand`, or `left` and `right`.
`serializeScalarExpression` provides canonical rendering. `Term` itself is unchanged, so
fact, literal, binding, and aggregate-value consumers do not need to change.

## Safety behavior

Arithmetic supports `+`, `-`, `*`, `/`, unary signs, and parentheses on either side of a
comparison. It is numeric-only and filter-only. Non-numeric operands, division by zero,
and non-finite results now throw `EngineSafetyError`; oversized expression trees fail
through parser/evaluator complexity limits.

Comparisons without arithmetic retain the previous atom, number, mixed-type, and proof
behavior. Arithmetic adds no proof or graph union members: comparisons continue to filter
the positive/absence evidence already present.

## SQLite

The native SQLite extension still supports comparisons between single terms. Its adapter
now rejects arithmetic comparison syntax explicitly rather than forwarding it to a
backend parser with different semantics.
