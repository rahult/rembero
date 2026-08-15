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

Tools exposed: `remember`, `recall`, `assert_facts`, `query`, `forget`, `list_memories`.
`remember`/`recall` take natural language; the rest take raw Datalog for direct, LLM-free access.

## CLI

```bash
node dist/cli.js remember "Rahul's dentist is Dr Chen"
node dist/cli.js recall   "Who is Rahul's dentist?"
node dist/cli.js query    'dentist(rahul, X)'        # raw Datalog, no LLM call
node dist/cli.js forget   'dentist(rahul, _)'
node dist/cli.js list
node dist/cli.js serve                                # MCP server on stdio
```

`-n <ns>` / `--namespace <ns>` selects the namespace to write to; `--namespaces a,b` or
`--namespaces '*'` selects which namespaces recall/query/list read from.

## Storage

Memories live in plain text at `~/.rembero/memory/<namespace>.dl`, one canonical clause per
line — readable, hand-editable, diffable. Duplicate facts (and alpha-equivalent rules) are
deduplicated on write. Files are written atomically.

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
npm run dev -- …  # run the CLI from source (tsx)
```
