# Migrating to 0.37

Version 0.37 is additive. Existing SQLite query, explanation, native SQL, extension ABI,
database files, and personal knowledge behavior require no migration.

New interfaces are:

- `DatalogDatabase.datalogPlan(...)` and SQLite plan result/relation/column/derived types;
  and
- CLI `sqlite-plan <database> <datalog-program>`.

Planning requires the same installed native extension and Node.js 22.13+ adapter as other
SQLite commands. It performs schema reads only and does not replace `EXPLAIN QUERY PLAN`
for SQLite cost analysis.
