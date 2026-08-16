# Migrating to 0.15

Version 0.15 is additive. Databases, `.dl` files, and existing native SQLite queries need
no migration.

`DatalogDatabase.datalogQuery`, `DatalogDatabase.datalogExplain`, `sqlite-query`, and
`sqlite-explain` now accept raw conjunctions, stratified negation, arithmetic comparison
expressions, scalar aggregates, and programs with multiple derived predicates. These
queries read referenced SQLite relations through the bounded portable bridge.
For a multi-rule program, the first rule head selects the result relation and must contain
distinct named variables. Rule ordering therefore matters for result selection, though
fact insertion order does not affect results or first-witness proofs.

Applications can call `sqliteDatalogExecutionMode(input)` when they need to disclose or
assert the selected path. Existing positive single-head rules continue to use the native
extension.

Advanced queries reject SQLite `NULL`, BLOB, non-finite numeric values, and integers
outside the JavaScript safe range rather than coercing them. They use Datalog value
semantics instead of SQLite affinity and collation. If an application depends on SQLite
coercion, keep that filtering in SQL and expose a view containing normalized text and
numeric columns.

The stock loadable extension functions remain unchanged and intentionally narrower.
Integrity constraints and entity identity declarations remain personal knowledge-store
policies rather than SQLite query syntax.
