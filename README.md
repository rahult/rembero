# rembero

[![CI](https://github.com/rahult/rembero/actions/workflows/ci.yml/badge.svg)](https://github.com/rahult/rembero/actions/workflows/ci.yml)

Logic-based memory for LLM chats and agents. Instead of fuzzy vector recall, rembero stores
memories as **Datalog facts and rules** and answers questions by **logical inference** —
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

The raw Datalog tools (`query`, `assert_facts`, `forget`, `list_memories`) work with no
API key at all — only natural-language `remember`/`recall` call the LLM.

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

Tools exposed: `remember`, `recall`, `recall_explain`, `assert_facts`, `query`,
`explain_query`, `forget`, and `list_memories`. `remember`/`recall` take natural
language; the raw query tools are direct and LLM-free.

For inspectable reasoning, `recall_explain` and `explain_query` return the bindings plus
deterministic derivation proofs, durable source statements, and a query-scoped personal
knowledge graph. Facts remain authoritative in the same portable `.dl` files; the graph
is derived and cannot drift into a second source of truth.

## CLI

```bash
node dist/cli.js remember "Rahul's dentist is Dr Chen"
node dist/cli.js recall   "Who is Rahul's dentist?"
node dist/cli.js recall-explain "Who are Rahul's colleagues?"
node dist/cli.js query    'dentist(rahul, X)'        # raw Datalog, no LLM call
node dist/cli.js explain  'colleague(rahul, X)'      # proof + source + graph, no LLM call
node dist/cli.js forget   'dentist(rahul, _)'
node dist/cli.js list
node dist/cli.js serve                                # MCP server on stdio
```

`-n <ns>` / `--namespace <ns>` selects the namespace to write to; `--namespaces a,b` or
`--namespaces '*'` selects which namespaces recall/query/list read from.

Namespaces organize one local personal store; they are not access-control or tenant
boundaries. Use separate `REMBERO_HOME` roots and server processes when data must be
isolated. Natural-language operations reject credential-like input before calling an
external LLM. Raw Datalog operations remain local and should never be used to store
secrets.

## Storage

Memories live in plain text at `~/.rembero/memory/<namespace>.dl`, one canonical clause per
line — readable, hand-editable, diffable. Duplicate facts (and alpha-equivalent rules) are
deduplicated on write. Files are written atomically. Journaled mutations carry stable
operation IDs; facts captured through `remember` retain their source statement for later
explanation. Credential-like source text is redacted before journaling. See
[the explainable graph contract](docs/EXPLAINABLE-KNOWLEDGE-GRAPH.md).

## SQLite extension (experimental)

Rembero also ships the source for a real loadable SQLite extension. It treats ordinary
SQLite tables (and views) as Datalog predicates: arguments map to columns by position,
rules compile to read-only SQL, and SQLite remains the storage, transaction, and query
engine. This is a separate application-facing primitive; the existing MCP memory store
continues to use portable `.dl` files.

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
import { openDatalogDatabase } from 'rembero';

const db = await openDatalogDatabase('world.db');
const rule = 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.';
console.log(db.datalogSql(rule));   // inspect the generated SELECT
console.log(db.datalogQuery(rule)); // execute it and parse the JSON rows
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

The current recursive boundary is intentionally narrow: all rules in a program derive the
same predicate and provenance retains the first derivation encountered, rather than all
possible proofs. Programs are limited to 64 KiB and 16 rules; evaluation is capped at
100,000 loaded base rows, 10,000 derived rows, 1,000 fixpoint rounds, proof depth 128, and
10 million tuple checks, and 16 MiB of output. Unsafe, malformed, mixed-head,
arity-inconsistent, or cap-exceeding programs fail closed. Extension loading is disabled
again immediately after the library is loaded.

## The Datalog dialect

- Facts must be ground: `works_at(rahul, acme).` `birth_year(rahul, 1985).`
- Atoms are lowercase (`acme`) or quoted (`'Acme Corp'`); variables uppercase (`X`, `Who`);
  `_` is a wildcard in queries and rule bodies.
- Rules, including recursive ones: `ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).`
- Comparisons in rule bodies and queries: `=`, `!=`, `<`, `>`, `<=`, `>=`.
- No negation, arithmetic, or aggregation (v1). Every query terminates: evaluation is
  semi-naive bottom-up over a finite fact universe, with belt-and-braces derivation caps.
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
