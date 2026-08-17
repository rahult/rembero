# Migrating to 0.20

Version 0.20 is additive. Existing facts, rules, constraints, journals, snapshots,
queries, and query-level aggregates require no migration.

Programs may now store one aggregate reduction in a rule:

```prolog
team_size(Team, Count) :- count(*) as Count where member(Team, Person).
```

New public TypeScript APIs are `AggregateRuleClause`, `AggregateRuleSpec`, and
`isAggregateRule(...)`. `DerivationProof` may add a nested `aggregate` property when its
fact was produced by an aggregate rule. Consumers that exhaustively validate proof JSON
should allow this additive field.

Aggregate dependency cycles now fail stratification. Native `datalog_sql` continues to
reject aggregation, while `datalog_query` and `datalog_explain` execute aggregate rules
through the portable SQLite bridge.

See [the reusable aggregate-rule contract](RULE-AGGREGATION.md).
