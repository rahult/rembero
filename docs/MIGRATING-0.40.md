# Migrating to 0.40

Version 0.40 is additive. Existing memories, rules, proofs, graphs, queries, and stored
formats require no migration.

The natural-language extraction prompt now receives the caller's accepted/tentative
authority mode:

- accepted mode skips hedged claims instead of silently promoting them to accepted truth;
- tentative mode asks the model to extract explicitly stated durable uncertainty as an
  ordinary clause, after which Rembero assigns tentative trust locally; and
- alias-only statements remain no-ops instead of becoming inert `same_person` facts.

Callers already using `{ trust: 'tentative' }` require no code change. The behavior is
now explicit and consistent across the verified models.

`npm run eval:extract` adds a live 15-case extraction checkpoint for exact additions,
removals, corrections, rules, duplicates, trust, policy/identity boundaries, and local
secret rejection.
