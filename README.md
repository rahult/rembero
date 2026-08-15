# rembero

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

## Setup

```bash
npm install
npm run build
```

Create `.env` in the project root (or export the variables):

```
LLM_API_KEY=sk-or-...                          # OpenRouter API key
LLM_BASE_URL=https://openrouter.ai/api/v1      # optional, this is the default
LLM_MODEL=openai/gpt-5.6-luna                  # optional, this is the default
```

## Use from Claude Code (MCP)

```bash
claude mcp add rembero -- node /path/to/rembero/dist/cli.js serve
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

## Development

```bash
npm test          # vitest suite (engine, store, pipeline, tools)
npm run build     # tsc
npm run dev -- …  # run the CLI from source (tsx)
```
