# Migrating to 0.47

Version 0.47 is additive. Existing relational queries continue to return all bound
variables, and aggregate syntax is unchanged.

`RelationalQuerySpec` adds optional ordered `project`. The canonical text form is:

```prolog
select Answer1, Answer2 where goal1(...), goal2(...)
```

Ground queries and legacy all-variable queries require no changes. Grounded natural-
language recall may now return query strings beginning with `select`; consumers should
continue treating `RecallResult.bindings` as authoritative rather than reparsing query
text with an older grammar.
