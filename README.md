# rembero

[![CI](https://github.com/rahult/rembero/actions/workflows/ci.yml/badge.svg)](https://github.com/rahult/rembero/actions/workflows/ci.yml)

Logic-based memory for LLM chats and agents. Instead of fuzzy vector recall, rembero stores
memories as **Datalog facts, rules, and explicit integrity constraints** and answers
questions by **logical inference** —
an LLM (GPT-5.6 Luna via OpenRouter) translates natural language in and out, and a
built-in, zero-dependency Datalog engine does the reasoning deterministically.

```
"Rahul works at Acme. Mira also works at Acme.          works_at(rahul, acme).
 People who work at the same company are colleagues."   works_at(mira, acme).
                                            ──────────▶ colleague(X, Y) :- works_at(X, C),
                                                                          works_at(Y, C), X != Y.

"Who are Rahul's colleagues?"  ──▶  ?- colleague(rahul, X)  ──▶  "Rahul's colleague is Mira."
```

Facts nobody ever stated directly (like `colleague(rahul, mira)`) are *derived*, not stored.

## Install

```bash
npm install -g rembero        # or run ad hoc with: npx -y rembero
```

Configuration is via environment variables (a `.env` file in the working directory also works):

| Variable | Required | Default |
|---|---|---|
| `LLM_API_KEY` | for `remember`/`recall` only | — (an [OpenRouter](https://openrouter.ai) key) |
| `LLM_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | no | `openai/gpt-5.6-luna` |
| `REMBERO_HOME` | no | `~/.rembero` (memories live in `$REMBERO_HOME/memory/`) |
| `REMBERO_LLM_ALLOWED_NAMESPACES` | no | all namespaces (comma-separated allowlist when set; empty blocks all LLM export) |
| `REMBERO_AUTO_CAPTURE_DAILY_CAP` | no | `10` unique attempts per namespace/UTC day |
| `REMBERO_AUTO_CAPTURE_TAIL_BYTES` | no | `24576` bytes (maximum `49152`) |
| `REMBERO_VALID_TIME_MODE` | no | `delete`; set `archive_until` to preserve superseded facts |
| `REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT` | no | `32` detailed predicates on the first recall pass (range: 1–256) |
| `REMBERO_INTEGRITY_MODE` | no | `off`; use `strict` or migration mode `no_new_violations` for atomic write rejection |
| `REMBERO_INTEGRITY_NAMESPACES` | no | target namespace only; `*` or a comma-separated governed view when enforcement is active |
| `REMBERO_ENTITY_IDENTITY` | no | `off`; use `canonical` for explicit position-scoped alias projection |

The raw Datalog tools (`assert`, `claims`, `accept`, `reject`, `supersede`, `query`,
`check`, `assert_facts`, `assert_tentative`, `review_tentative`, `resolve_tentative`,
`supersede_facts`, `what-if`, `what_if`, `why-not`, `why_not`, `topology`,
`knowledge_topology`, `forget`, `list_memories`)
work with no API key at all—only
natural-language `remember`/`recall` call the LLM.

## Use from Claude Code (MCP)

```bash
claude mcp add rembero --env LLM_API_KEY=sk-or-... -- npx -y rembero serve
```

From a git checkout instead: `claude mcp add rembero -- node /path/to/rembero/dist/cli.js serve`

To make agents use memory *proactively*, add a snippet like this to your `CLAUDE.md`
(or system prompt):

```markdown
## Memory (rembero)
- At the start of tasks, use `recall` to check for relevant remembered context.
- When I state something durable — a preference, decision, relationship, or fact about
  me or a project — store it with `remember`. Updates ("X is now Y") supersede old facts.
- Never store secrets or transient details. When unsure whether to remember, ask.
```

Tools exposed: `remember`, `recall`, `recall_explain`, `assert_facts`,
`assert_tentative`, `review_tentative`, `resolve_tentative`, `supersede_facts`,
`query`, `explain_query`, `check_integrity`, `conflict_views`, `history`, `forget`,
`what_if`, `why_not`, `knowledge_topology`, `checkpoint_journal`, `list_checkpoints`,
and `list_memories`.
`remember`/`recall` take natural language; the raw query and integrity tools are direct
and LLM-free.

Raw MCP writes accept an optional caller-stable `opId`. Retrying `assert_facts`,
`supersede_facts`, or `forget` with the same namespace, operation, ID, and normalized request returns the
original result without applying the mutation again. Reusing an ID for a different
request returns a structured `operation_conflict` error.

For inspectable reasoning, `recall_explain` and `explain_query` return the bindings plus
deterministic derivation proofs, durable source statements, and a query-scoped personal
knowledge graph. Facts remain authoritative in the same portable `.dl` files; the graph
is derived and cannot drift into a second source of truth.

Large explanations can be exported as deterministic subgraphs without changing their
rows or proofs. MCP graph selectors choose a result support chain, a node's complete
support closure, or a bounded neighborhood.

Natural-language recall returns an explicit status: `answered`, `no_match`,
`unanswerable`, or `schema_budget_exhausted`. The last status is an honest bounded-result
signal, not a claim that no relevant memory exists.

### Optional ambient capture

Manual `remember` remains the default. To opt into ambient capture at the end of Claude
Code turns:

```bash
rembero init-hooks --namespace personal
```

This safely merges one asynchronous Stop hook into your personal Claude settings. It
reads only a bounded trusted transcript tail, removes code/tool noise, rejects secrets,
deduplicates repeated Stop events, applies a per-namespace daily request cap, and accepts
only additive ground facts explicitly grounded in the user's words. It never installs at
package-install time and never performs automatic retractions.

Every capture, empty result, failure, cap, and duplicate is visible locally:

```bash
rembero review --namespace personal
rembero review --namespace personal --forget 2,5
rembero init-hooks --remove
```

The raw transcript is not persisted as per-fact provenance. See the
[auto-capture contract](docs/AUTO-CAPTURE.md) for settings scopes, quotas, review JSON,
and the async-hook lifecycle boundary.

## CLI

```bash
node dist/cli.js remember "Rahul's dentist is Dr Chen"
node dist/cli.js recall   "Who is Rahul's dentist?"
node dist/cli.js recall   "Who owns Atlas?" --schema-predicate-limit 48
node dist/cli.js recall-explain "Who are Rahul's colleagues?"
node dist/cli.js assert   ':- status(Person, active), status(Person, terminated).'
node dist/cli.js check    --proof-limit 2 --max-violations 100
node dist/cli.js conflicts mira # focused cross-policy conflict evidence
node dist/cli.js conflicts mira --as-of-sequence 17 # exact recorded conflict view
node dist/cli.js assert   'status(mira, terminated).' --integrity-mode strict
node dist/cli.js assert   'status(mira, paused).' --trust tentative
node dist/cli.js claims
node dist/cli.js accept   'status(mira, paused).' --op-id review-17
node dist/cli.js assert   'status(mira, active).' --op-id change-123 # retry-safe
node dist/cli.js supersede 'works_at(mira, initech).' \
  --pattern 'works_at(mira, _)' --at '2026-08-16T16:59:00.000Z' --op-id job-42
node dist/cli.js remember 'Mira is now terminated' --integrity-mode no_new_violations
node dist/cli.js explain  'path(a, X)' --proof-limit 4 # inspect every bounded proof path
node dist/cli.js query    'dentist(rahul, X)'        # raw Datalog, no LLM call
node dist/cli.js query    'employee(X), \+ suspended(X)' # closed-world negation
node dist/cli.js query    'age(X, A), age(dana, D), A > D + 5' # numeric arithmetic filter
node dist/cli.js query    'count(*) as Count where works_at(Person, acme)'
node dist/cli.js explain  'colleague(rahul, X)'      # proof + source + graph, no LLM call
node dist/cli.js what-if  'colleague(mira, Who)' \
  --without 'works_at(rahul, _)' --assume 'works_at(rahul, acme).'
node dist/cli.js why-not  'colleague(mira, rahul)' # missing premises + nearby evidence
node dist/cli.js topology 'colleague' --direction upstream # rule dependency closure
node dist/cli.js explain  'path(a, X)' --graph-result 2 # one result's complete support
node dist/cli.js explain  'path(a, X)' --graph-neighbors 'entity:["a"]' --graph-depth 2
node dist/cli.js query    'works_at(mira, X)' --entity-identity canonical
node dist/cli.js forget   'dentist(rahul, _)'
node dist/cli.js forget   'dentist(rahul, _)' --op-id forget-123 # retry-safe
node dist/cli.js history  'works_at(mira, _)' --json
node dist/cli.js query    'works_at(mira, X)' --as-of-sequence 17 # exact recorded past
node dist/cli.js checkpoint --op-id backup-2026-08-17 # rotate the active journal safely
node dist/cli.js checkpoints                           # inspect verified boundaries
node dist/cli.js list
node dist/cli.js review --namespace personal           # inspect ambient captures
node dist/cli.js review --namespace personal --forget 2 # explicit prune by number
node dist/cli.js init-hooks --namespace personal       # opt in to Claude Stop capture
node dist/cli.js serve                                # MCP server on stdio
```

Natural-language supersession deletes the old fact by default. Opt into valid-time archives with
`REMBERO_VALID_TIME_MODE=archive_until` or `remember --valid-time-mode archive_until`.
An update then keeps the preceding fact as an ordinary
`<predicate>_until(..., '<ISO instant>').` clause. `history` replays the bounded journal
in authoritative append order, while past-tense recall can query and explain those
portable archive facts. See [the temporal history contract](docs/TEMPORAL-HISTORY.md).

Version 0.16 makes that correction primitive directly available without an LLM. CLI
`supersede` and MCP `supersede_facts` atomically end up to 64 matched ground facts,
preserve each as `_until`, and add explicit replacement clauses under the same integrity,
retry, journal, and crash-recovery boundary as other writes. A caller-supplied `at` must
be a canonical UTC instant; it is descriptive valid-time metadata, never an ordering
authority. See [the temporal-correction contract](docs/TEMPORAL-CORRECTIONS.md).

Version 0.17 lazily indexes a relation's first argument whenever a rule or query has
already bound it. Selective joins, negation, recursion, aggregates, explanations, and the
SQLite portable bridge use the same insertion-ordered lookup without persisting a second
authority or reordering authored goals. Checked-in selective-join and recursive-growth
benchmarks require byte-identical rows and proofs, at least a 2x median speedup, and at
least a 100x reduction in deterministic relation work. Run `npm run bench:engine`; see
[the deterministic indexing contract](docs/ENGINE-INDEXING.md).

Version 0.18 groups explicit integrity violations into focused personal conflict views.
`rembero conflicts [focus]` and MCP `conflict_views` combine every policy violation for
the same first alpha-stable constraint binding, with declaration provenance, fact proofs,
stable cluster IDs, and selectable evidence graphs. Canonical aliases and exact recorded
snapshots use the existing opt-in contracts; no conflict store or inferred subject schema
is added. See [the conflict-view contract](docs/CONFLICT-VIEWS.md).

Version 0.19 no longer treats every non-empty natural-language query as semantically
correct. When deterministic local evidence finds a same-ground-anchor predicate
competitor or a historical query missing its named later state, recall performs one
bounded review before accepting the rows. The response records repeat, correction, or
unanswerable decisions in `queryReviews`; ordinary grounded recalls keep the one-call
path. See
[the recall disambiguation contract](docs/RECALL-DISAMBIGUATION.md).

Version 0.20 makes exact aggregation reusable inside rules. A clause such as
`team_size(Team, Count) :- count(*) as Count where member(Team, Person).` derives one
proof-carrying count per team for later rules, recall, integrity policy, graphs, and the
SQLite portable bridge. Aggregate dependency cycles fail stratification. See
[the aggregate-rule contract](docs/RULE-AGGREGATION.md).

Version 0.21 separates tentative claims from accepted knowledge. Tentative facts remain
explicit `.dl` declarations and journal entries but are excluded from reasoning by
default. Opt-in reads label their proofs, sources, and graph claims; deterministic
accept/reject operations preserve recorded-time and integrity authority. See
[the knowledge-trust contract](docs/TRUSTED-KNOWLEDGE.md).

Version 0.22 removes the active journal's long-running growth bottleneck without deleting
history. `checkpoint` atomically rotates `journal.log` into an immutable, content-addressed
segment and publishes an exact clause/source checkpoint. Recorded sequence numbers remain
global across every segment and the active tail; reads reject missing, reordered, or
tampered artifacts. See [the journal-checkpoint contract](docs/JOURNAL-CHECKPOINTS.md).

Version 0.23 adds deterministic counterfactual impact analysis. `what-if` evaluates
fact-only additions, removals, and corrections against a consistent current snapshot,
then returns before/after rows, changed proof evidence, introduced or resolved integrity
violations, and hypothetical provenance in the explanation graph. It never calls an LLM
or writes a namespace, source, or journal entry. See
[the counterfactual-impact contract](docs/COUNTERFACTUAL-IMPACT.md).

Version 0.24 explains deterministic failure rather than returning an opaque empty row
set. `why-not` follows conjunction bindings and every matching rule branch to missing
facts, present negated facts, false comparisons, recursive cycles, or aggregate output
mismatches. Nearby facts retain proofs and durable sources; a separate blocker graph
connects the query, attempted rules, failures, and observations. Empty `recall-explain`
results include the same `whyNot` evidence. See
[the why-not explanation contract](docs/WHY-NOT-EXPLANATIONS.md).

Version 0.25 makes the rule system itself inspectable. `topology` maps predicates,
alpha-equivalent rule groups, policies, positive/negative/aggregate dependencies,
strata, recursive components, provenance, and undefined inputs. A predicate focus can
select its complete upstream requirements, downstream influence, or both while retaining
whole rule and policy nodes. See
[the knowledge-topology contract](docs/KNOWLEDGE-TOPOLOGY.md).

At 100+ predicates, recall ranks a deterministic local schema slice, preserves rule
dependencies and temporal companions, and evaluates every accepted query against the
complete selected namespaces. Empty or unanswerable results from a partial slice trigger
one bounded widening pass; if completeness still cannot be established, recall reports
`schema_budget_exhausted` instead of inventing “no memory.” Pruning diagnostics are
returned by the library and MCP surfaces. See
[the recall schema-pruning contract](docs/RECALL-SCHEMA-PRUNING.md).

Explanations keep the first deterministic witness by default. Pass `--proof-limit <n>`
(maximum 16) to `explain` or `recall-explain` to request a complete bounded set of
branch-simple alternative derivations. The same `proofLimit` option is available on the
MCP explain tools. Additional proofs remain query-scoped, retain ordered source evidence,
and appear as distinct proof instances in the graph; no graph sidecar or proof index is
persisted. If more proofs exist than the requested limit, Rembero fails explicitly rather
than presenting incomplete evidence as complete. See
[the alternative-proof contract](docs/ALTERNATIVE-PROOFS.md).

Explicit headless constraints describe forbidden knowledge states without guessing
semantics from predicate names. For example,
`:- status(Person, active), status(Person, terminated).` flags every person with both
current statuses. `check` / MCP `check_integrity` returns complete bounded violations
with proof, source, and graph evidence; the CLI exits `2` when findings exist. Constraints
remain inert during normal query/recall and cannot be generated by natural-language
memory extraction. See [the integrity-constraint contract](docs/INTEGRITY-CONSTRAINTS.md).

Version 0.10 can promote those declarations into an opt-in atomic write boundary.
`strict` rejects any violating candidate; `no_new_violations` permits legacy findings to
remain or be repaired while rejecting new violation identities. Every rejection carries
the same bounded proof, source, and query-scoped graph evidence as `check`; CLI exit `3`
means no mutation was committed. All supported writers share one cross-process mutation
lock so a cross-namespace candidate cannot race another Rembero 0.10 writer. Audit remains
the default. See [the enforcement and migration contract](docs/INTEGRITY-ENFORCEMENT.md).

Version 0.11 can treat explicitly declared names as one entity without rewriting stored
facts. `rembero_alias(Alias, Canonical).` declares a chain and
`rembero_entity_position(Predicate, Arity, ZeroBasedPosition).` limits projection to
typed-by-policy argument positions. Raw reads remain literal by default; opt in with
`--entity-identity canonical`, `REMBERO_ENTITY_IDENTITY=canonical`, or the matching
library/MCP option. Proofs retain the exact literal source and graphs annotate canonical
entities with alias provenance. History always stays literal. See
[the entity identity contract](docs/ENTITY-IDENTITY.md).

Version 0.12 adds bounded graph navigation to explanation, recall, integrity, and
write-rejection evidence. Use `--graph-result`, `--graph-support`, or
`--graph-neighbors` (with optional `--graph-depth`) in the CLI, or the equivalent
`graphSelector` object in MCP/library calls. Selection never changes result rows, proofs,
rules, or stored facts; it only projects the returned graph. See
[the graph-navigation contract](docs/GRAPH-NAVIGATION.md).

Version 0.13 makes raw assertions, retractions, and imports retry-safe. Supply a stable
`--op-id` in the CLI, `opId` in MCP, or `MutationContext.opId` in the library. Matching
retries return the first durable result even when it included duplicates or removed
facts; conflicting reuse fails with `OperationConflictError` (`operation_conflict`, CLI
exit `4`). See [the retry-safe write contract](docs/RETRY-SAFE-WRITES.md).

Version 0.14 adds exact recorded-time snapshots across recall, query, explanation,
integrity audit, and listing. `--as-of-sequence 0` means before the journal; higher values
mean after that global journal entry. Rules, explicit identity, provenance, and graphs are
evaluated from the selected past view. Snapshot reads first reconcile the complete journal
with current files and fail closed if hand edits or legacy writes make history incomplete.
This is separate from descriptive valid-time timestamps and does not claim full bitemporal
interval algebra. See [the recorded-time snapshot contract](docs/RECORDED-TIME-SNAPSHOTS.md).

`-n <ns>` / `--namespace <ns>` selects the namespace to write to; `--namespaces a,b` or
`--namespaces '*'` selects which namespaces recall, query, check, list, and history read
from.

Namespaces organize one local personal store; they are not access-control or tenant
boundaries. Use separate `REMBERO_HOME` roots and server processes when data must be
isolated. Natural-language operations reject credential-like input before calling an
external LLM. Raw Datalog operations remain local and should never be used to store
secrets. Set `REMBERO_LLM_ALLOWED_NAMESPACES=work,shared` to keep every other namespace
local-only; the policy covers both remembering and recalling, including wildcard reads.

## Storage

Memories live in plain text at `~/.rembero/memory/<namespace>.dl`, one canonical clause per
line — readable, hand-editable, diffable. Duplicate facts, alpha-equivalent rules, and
alpha-equivalent integrity constraints are deduplicated on write. Files are written
atomically. All supported fact/rule/constraint mutations are globally serialized so
optional integrity validation and commit observe the same snapshot. Journaled mutations carry stable
operation IDs; facts captured through `remember` retain their source statement for later
explanation. Cross-process writers are serialized so background capture cannot overwrite
a simultaneous manual mutation. Credential-like source text is redacted before
journaling, and active journal capacity is checked before mutation. Immutable checkpoint
segments reset that active-file capacity while preserving the complete recorded sequence.
Opt-in supersessions atomically
close old facts, add their `_until` archives and replacements, and record exact source
lineage without changing explicit `forget`. See
[the explainable graph contract](docs/EXPLAINABLE-KNOWLEDGE-GRAPH.md).

## SQLite extension (experimental)

Rembero also ships the source for a real loadable SQLite extension. It treats ordinary
SQLite tables (and views) as Datalog predicates: arguments map to columns by position,
and SQLite remains the storage and transaction authority. Ordinary positive rules use
the native extension; the Node adapter deterministically bridges advanced rules to the
same bounded evaluator used by portable `.dl` knowledge. This is a separate
application-facing primitive; the existing MCP memory store continues to use portable
`.dl` files.

V0 supports macOS and Linux. Build the extension with a C compiler and the SQLite
development headers. From a source checkout use:

```bash
npm run build:sqlite
```

From an installed npm package use `rembero sqlite-build`. The command compiles the native
library inside the installed package; it does not run automatically during installation,
so Rembero's existing non-SQLite memory features do not acquire a native toolchain
requirement.

Then create a normal database and query it through the CLI (the adapter requires Node.js
22.13 or newer):

```bash
sqlite3 world.db <<'SQL'
CREATE TABLE works_at(person TEXT, company TEXT);
INSERT INTO works_at VALUES ('alice', 'acme'), ('bob', 'acme'), ('carol', 'other');
SQL

npm run build
node dist/cli.js sqlite-query world.db \
  'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
```

The result is deterministic JSON:

```json
[
  { "X": "alice", "Y": "bob" },
  { "X": "bob", "Y": "alice" }
]
```

The public library adapter exposes the same path:

```ts
import { openDatalogDatabase, sqliteDatalogExecutionMode } from 'rembero';

const db = await openDatalogDatabase('world.db');
const rule = 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.';
console.log(db.datalogSql(rule));   // inspect the generated SELECT
console.log(db.datalogQuery(rule)); // execute it and parse the JSON rows
console.log(sqliteDatalogExecutionMode(rule)); // "native"
db.close();
```

Recursive programs use multiple rules for one derived predicate. Evaluation is bounded,
semi-naive, and set-based: each round joins at least one recursive body literal against
only the previous round's delta.

```ts
const program = `
  path(X, Y) :- edge(X, Y).
  path(X, Y) :- edge(X, Z), path(Z, Y).
`;

console.log(db.datalogQuery(program));
console.log(db.datalogExplain(program)); // one nested derivation proof per result
```

Inside SQLite, the registered scalar functions are `datalog_sql(rule)`,
`datalog_query(program)`, and `datalog_explain(program)`. `datalog_sql` deliberately
remains a single non-recursive rule compiler; recursive programs execute through the
fixpoint evaluator. Rules support joins through repeated variables, text/number constants,
and `=`, `!=`, `<`, `>`, `<=`, and `>=`.

`DatalogDatabase.datalogQuery`, `DatalogDatabase.datalogExplain`, `sqlite-query`, and
`sqlite-explain` also support raw conjunctions, stratified negation, arithmetic comparison
expressions, scalar aggregates, and programs with multiple derived predicates. The adapter
loads only referenced tables inside a read savepoint, canonicalizes their rows, and runs
the portable evaluator. For a rule program, the first rule head is the result relation and
must contain distinct named variables; later rules may define that relation or its
dependencies. `sqliteDatalogExecutionMode(input)` reports which path will run.
This bridge deliberately uses Datalog value equality rather than SQLite affinity and
accepts only text plus finite safe-range integer/real values; `NULL`, BLOB, non-finite,
and unsafe integer values fail closed.

The stock SQLite scalar functions remain the smaller native surface, so applications that
load only the `.dylib`/`.so` do not receive those adapter capabilities. `datalog_sql` also
rejects advanced syntax because it promises one inspectable SQLite `SELECT`. Integrity
constraints and entity identity declarations remain personal knowledge-store policies,
not database query syntax.

Both paths are bounded. Adapter inputs are limited to 64 KiB, 100,000 referenced base
rows, 10,000 additional facts, 1,000 rounds, 10,000 output rows, proof depth 128, and
16 MiB of input/output. Native programs retain their 16-rule, tuple-check, and proof caps.
Unsafe, malformed, arity-inconsistent, unsupported-value, or cap-exceeding queries fail
closed. Extension loading is disabled again immediately after the library is loaded. See
[SQLite determinism and parity](docs/SQLITE-DETERMINISM.md) for the exact matrix.

## The Datalog dialect

- Facts must be ground: `works_at(rahul, acme).` `birth_year(rahul, 1985).`
- Valid-time archives are ordinary system-managed facts such as
  `works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').`
- Atoms are lowercase (`acme`) or quoted (`'Acme Corp'`); variables uppercase (`X`, `Who`);
  `_` is a wildcard in queries and rule bodies.
- Rules, including recursive ones: `ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).`
- Explicit integrity constraints have no head and describe forbidden states:
  `:- active(Person), suspended(Person).` They use query-style range restriction, never
  derive facts, and are inspected only by `check` / `check_integrity`.
- Entity identity is explicit metadata: `rembero_alias('Mira Patel', mira).` declares
  an alias and `rembero_entity_position(works_at, 2, 0).` opts one zero-based argument
  position into canonical reads. The declarations never rewrite durable facts or history.
- Tentative trust is explicit metadata:
  `rembero_tentative('works_at(mira, acme).').` remains outside accepted reasoning until
  reviewed; use the typed CLI/MCP/library surfaces instead of authoring wrappers manually.
- Stratified closed-world negation: `available(X) :- employee(X), \+ suspended(X).`
  Variables in comparisons and negated literals must be bound by an earlier positive
  goal. Recursive dependency cycles containing negation are rejected.
- Comparisons in rule bodies and queries: `=`, `!=`, `<`, `>`, `<=`, `>=`. Numeric
  operands support deterministic `+`, `-`, `*`, `/`, unary signs, and parentheses with
  standard precedence: `older(X, Y) :- age(X, A), age(Y, B), A > B + 5.` Arithmetic is
  filter-only and cannot create values in facts, rule heads, relation arguments, or
  aggregate inputs. Non-numeric operands, division by zero, and non-finite results fail
  closed.
- Terminal scalar aggregation:
  `count(*) as Count where works_at(Person, acme)`, plus `sum(Value)`, `min(Value)`,
  and `max(Value)`. Aggregation consumes the complete logical solution set and fails
  closed at its dedicated input cap rather than silently reusing the normal row limit.
- Reusable grouped aggregation in rules:
  `company_size(Company, Count) :- count(*) as Count where works_at(Person, Company).`
  Every aggregate dependency is strictly stratified, and aggregate cycles are rejected.
- Every query terminates: arithmetic only filters a finite relation; evaluation remains
  stratified, semi-naive bottom-up over a finite fact universe, with belt-and-braces
  derivation and expression-complexity caps.
- Safety: facts must be ground; every head variable must appear in a positive body literal
  (range restriction). LLM output that violates this is rejected, retried once with the
  error message, then surfaced as an error — nothing unparsed ever reaches the store.

## Troubleshooting

- **`LLM_API_KEY is not set`** — export it, put it in `.env` in the directory you launch
  from, or pass it via `claude mcp add --env`. Only `remember`/`recall` need it.
- **HTTP 401/403 from the LLM** — key is invalid or lacks access to the model; try
  another `LLM_MODEL` you have access to on OpenRouter.
- **`failed to load ….dl`** — a memory file was hand-edited into a state that doesn't
  parse; the error names the file and line. Fix the line (or delete it) and retry.
  Nothing is ever silently dropped.
- **Server shows "disconnected" in Claude Code** — run `npx -y rembero serve` manually;
  anything printed before the JSON handshake (e.g. npm warnings) breaks stdio. Use
  `npx -y` (never a bare `npm run`) so nothing pollutes stdout.

## Development

```bash
npm test          # vitest suite (engine, store, pipeline, tools)
npm run build     # tsc
npm run build:sqlite # compile the native SQLite extension
npm run test:sqlite  # native + Node adapter + CLI end-to-end checks
npm run eval:recall # live labeled comparison of baseline and grounded recall prompts
npm run dev -- …  # run the CLI from source (tsx)
```

The recall eval reports exact-case accuracy, binding-row precision/recall/F1, and
answerability accuracy. It can also compare OpenRouter models or emit JSON; see
[docs/EVALS.md](docs/EVALS.md).

See [the stratified-negation contract](docs/STRATIFIED-NEGATION.md) for safety,
closed-world, proof, and SQLite-boundary details, and [the scalar aggregation
contract](docs/QUERY-AGGREGATION.md) for exact reduction and explanation semantics, and
[the arithmetic comparison contract](docs/ARITHMETIC-COMPARISONS.md) for numeric,
precedence, safety, and portability details. TypeScript consumers should read the
[0.2](docs/MIGRATING-0.2.md), [0.3](docs/MIGRATING-0.3.md),
[0.4](docs/MIGRATING-0.4.md), [0.5](docs/MIGRATING-0.5.md),
[0.8](docs/MIGRATING-0.8.md), [0.9](docs/MIGRATING-0.9.md), and
[0.14](docs/MIGRATING-0.14.md) migration notes as
applicable.
