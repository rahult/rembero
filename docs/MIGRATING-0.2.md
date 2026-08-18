# Migrating to Remembero 0.2

Version 0.2 adds stratified negation to the portable Datalog language. Existing positive
programs and runtime result objects retain their behavior, but TypeScript consumers must
account for additive union members in the public AST and proof types.

## Goal AST

`Goal` now includes `Negation`:

```ts
import { isComparison, isNegation, type Goal } from 'rembero';

function visit(goal: Goal) {
  if (isComparison(goal)) return visitComparison(goal);
  if (isNegation(goal)) return visitLiteral(goal.not);
  return visitLiteral(goal);
}
```

## Proofs

`ExplainedBindings.proofs` and `DerivationProof.because` now contain `ProofStep`, which is
`DerivationProof | AbsenceProof`. Narrow absence checks with the `negated` discriminator:

```ts
for (const step of explained.proofs) {
  if ('negated' in step) {
    console.log(step.predicate, step.pattern, step.stratum);
  } else {
    console.log(step.predicate, step.values, step.rule);
  }
}
```

An absence pattern uses `null` for an existential wildcard. Absence steps never carry
source metadata.

## Safety tightening

Variables in comparisons and negated literals must now be bound by an earlier positive
goal. Reorder `A >= 18, age(X, A)` to `age(X, A), A >= 18`. The earlier form already
failed at runtime; 0.2 rejects it during parsing.

## SQLite

The loadable SQLite extension remains positive-only in 0.2. Its entry points reject
`\+` explicitly. Use the portable engine for stratified-negation programs.
