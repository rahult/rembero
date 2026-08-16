# SQLite determinism and parity

Rembero 0.15 gives the Node SQLite adapter the same bounded rule semantics as the
portable evaluator without introducing a second persistent store. SQLite remains the
storage and transaction authority; advanced evaluation consumes a read-only snapshot of
only the relations named by the query.

## Execution surfaces

| Capability | `DatalogDatabase` and CLI | SQLite scalar functions | `datalog_sql` |
| --- | --- | --- | --- |
| Positive single-head rules, joins, constants, comparisons | Native | Native | Native single rule |
| Same-head recursion | Native | Native | Rejected |
| Multiple derived predicates | Portable bridge | Rejected | Rejected |
| Raw query conjunction | Portable bridge | Rejected | Rejected |
| Stratified negation | Portable bridge | Rejected | Rejected |
| Arithmetic comparison expressions | Portable bridge | Rejected | Rejected |
| Scalar aggregation | Portable bridge | Rejected | Rejected |
| Integrity constraints | Store policy | Rejected | Rejected |
| Entity identity declarations | Store policy | Rejected | Rejected |

`sqliteDatalogExecutionMode(input)` returns `native` or `portable` before execution. The
choice is semantic and deterministic; it does not depend on table contents or row order.
For a rule program, the first rule head selects the result relation. Its arguments must be
distinct named variables. This preserves the existing native query-rule convention while
allowing later rules to define multiple dependencies; reorder the first rule deliberately
when choosing a different result relation.

## Portable bridge contract

The bridge opens a SQLite savepoint, validates every referenced table and its arity,
reads its visible columns by position, converts supported values to ground Datalog facts,
sorts those facts canonically, evaluates the query, then releases the savepoint. It never
writes SQLite or a side database.

The value boundary is deliberate:

- SQLite text becomes a Datalog atom;
- finite integer and real values within JavaScript's safe integer boundary become Datalog
  numbers;
- `NULL`, BLOB, non-finite values, unsafe integers, missing relations, and arity mismatch
  fail closed;
- equality and ordering use portable Datalog semantics, not SQLite type affinity or
  collation.

The result order and first-witness proof are stable for the same logical relation even if
physical insertion order differs. Explanation results contain `proof`; raw conjunctions
with multiple proof-bearing goals also contain the complete ordered `proofs` array.

## Bounds

The adapter accepts at most 64 KiB of program text, 100,000 referenced base rows, 10,000
additional facts, 1,000 fixpoint rounds, and 10,000 result rows. Snapshot input and encoded
output are each capped at 16 MiB. Explanations retain the existing depth-128 and
100,000-node proof bounds; aggregate proof contributors are capped at 256.

The native extension retains its own 16-rule, tuple-check, derivation, proof-depth, and
output bounds. Choosing the portable bridge does not relax either engine's limits.

## Why two execution paths

The native C path remains useful for direct embedding and ordinary rules. Reimplementing
the complete portable semantics in C would create two rule engines whose edge cases could
drift. The bridge instead reuses one mature implementation while keeping all durable state
inside the caller's SQLite database. Cross-engine conformance tests lock the overlapping
semantics and portable-only tests lock the advanced path.
