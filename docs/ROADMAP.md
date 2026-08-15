# Rembero MVP Roadmap — ship as a public npm package

**Definition of shipped:** a stranger on a fresh machine gets working logical memory in
Claude Code in under 5 minutes:

```bash
export LLM_API_KEY=sk-or-...
claude mcp add rembero -- npx -y rembero serve
# then in chat: "Remember that my dentist is Dr Chen" → "Who's my dentist?"
```

…and it behaves sanely when facts change, when several sessions run at once, and when the
LLM misbehaves. Everything else is post-MVP.

**Where we are (v0.1.0, done):** Datalog engine + namespace store + Luna pipeline + MCP
server + CLI, 67 tests, live e2e verified, private repo on GitHub.

---

## Phase 1 — Correctness gaps users hit in week one  *(~1 day)*

The single biggest gap: **memory updates**. Today *"Mira now works at Initech"* adds
`works_at(mira, initech).` **alongside** `works_at(mira, acme).` — contradictory memory
that recall will happily report.

1. **Fact supersession.** Let extraction emit retractions: teach the prompt to output
   `retract: works_at(mira, _).` lines when the input states a change; pipeline applies
   retractions (existing `store.retract`) before asserting. Tests: update, partial update,
   retract-nothing-matches.
2. **Concurrent sessions.** Multiple Claude Code windows = multiple server processes with
   independent caches → last-writer clobbers the other's memories. Fix: re-read a
   namespace file when its mtime changed before any read/mutation (cheap stat call).
   Test: two `MemoryStore` instances interleaving writes.
3. **Skip the LLM when memory is empty.** `recall` on an empty namespace currently burns
   two LLM calls to say "no memories." Short-circuit with the honest answer.
4. **Round-trip hardening.** Property-style tests for nasty atoms (`'it''s'`, unicode,
   leading digits, 100-char strings) through parse → store → load → query.

## Phase 2 — Packaging & distribution  *(~half day)*

1. **npm-publishable package.json:** `files: ["dist"]`, `repository`, `keywords`,
   `prepublishOnly: npm test && npm run build`, LICENSE file.
2. **`REMBERO_HOME`** env var for the memory directory (store already takes a root arg —
   wire it through; needed for testing, containers, and shared setups).
3. **Cold-start check:** `npm pack`, install the tarball in a temp dir, verify
   `npx rembero serve` + `claude mcp add` work with zero repo context.
4. **Docs pass:** README install section rewritten for npm; document all env vars;
   troubleshooting section (bad key, no model access, corrupt .dl file).

## Phase 3 — Chat ergonomics (agent-initiated capture)  *(~half day)*

The tool descriptions ARE the product — they're what makes an agent actually use memory.

1. **Tune tool descriptions** with concrete trigger guidance: *when* to remember
   (stable facts about the user, decisions, preferences), when NOT to (secrets,
   transient context). Add "never store passwords/API keys" to the extraction prompt.
2. **Ship a copy-paste CLAUDE.md snippet** in the README: "At session start, recall
   relevant context; proactively remember durable facts the user states."
3. **Recall fallback:** when the generated query returns 0 rows, give Luna one shot at an
   alternative query (schema + failed query included) before answering "no memory."

## Phase 4 — Trust & observability  *(~half day)*

1. **Operation journal:** append-only `~/.rembero/journal.log` recording every
   remember/assert/forget with timestamp and source text — the answer to "why does it
   think that, and when did I tell it?"
2. **`rembero export` / `rembero import`** (concat/load .dl files) for backup and moving
   machines.
3. **Error UX:** all tool errors phrased for end users, never stack traces.

## Phase 5 — Release engineering  *(~half day)*

1. **GitHub Actions CI:** typecheck + tests on push/PR, Node 20/22/24 matrix; badge in README.
2. **Make the repo public**, add a short demo GIF/asciinema to the README.
3. **Publish v0.1.0 to npm** (manual first release), smoke-test the published package
   from a clean machine/dir, tag + GitHub release notes.

---

## Explicitly deferred (post-MVP)

- Negation / aggregation / arithmetic in the engine
- Auto-capture hooks (background extraction from conversations)
- Temporal facts & provenance-aware queries ("where did Mira work in 2024?")
- Hybrid vector + logic retrieval
- Hosted/multi-user service, web UI
- Non-Claude MCP client guides (Cursor, Windsurf) — works today, docs later

## Suggested order & effort

Phases are sequential and total **~3 focused days**. Phase 1 is the only one with real
design risk (supersession semantics); everything after is mechanical. If you want to ship
faster, Phase 4 can slip to v0.1.1 without hurting the "usable" bar.
