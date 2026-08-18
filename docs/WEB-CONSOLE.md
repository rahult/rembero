# Local personal knowledge web console

Remembero 0.53 adds a modern local web interface for testing the complete personal knowledge
workflow against the real store, rule engine, proofs, search, health report, and graph.
It is a product surface over Remembero—not a mocked dashboard.

## Start

```bash
npm run web:dev
```

Open `http://127.0.0.1:4318`. The development server uses one origin for the API and Vite
client, so mutations do not require cross-origin access.

For the production build:

```bash
npm run web
```

The default memory root is `.rembero-web/`, deliberately separate from existing Remembero
memory. A sourced Personal demo workspace is seeded only when that sandbox is empty. Set
`REMBERO_WEB_SEED_DEMO=false` for an empty workspace, or point
`REMBERO_WEB_ROOT` at another explicit directory.

## Real use case

The supplied workspace models an Atlas project briefing:

- Rahul owns Atlas and Maya contributes;
- vendor security review blocks Atlas;
- Rahul promised Maya an update;
- three reviewed rules derive collaboration, follow-up, and project risk.

Guided questions such as “Who is collaborating on Atlas?” execute exact deterministic
Datalog locally and return real bindings, sourced rule proofs, and a proof graph. “What
gift does Maya want?” intentionally returns a non-answer with clearly separated related
knowledge.

Custom questions use the ordinary model-assisted recall pipeline when `LLM_API_KEY` is
configured. The UI labels this boundary; guided questions, exact evidence, local search,
health, structured capture, and explicit graph browse remain model-free.

## Product surfaces

- **Ask** — guided or custom recall, canonical query, supported answer, proof claims,
  authored rules, durable sources, and related discovery for non-answers.
- **Knowledge** — deterministic local search across fact, rule, and policy text with exact
  score reasons and provenance.
- **Graph** — bounded explicit stored relationships on an accessible SVG canvas and an
  equivalent ordered relationship list. It never presents graph proximity as proof.
- **Rules** — current authored rules and their exact canonical definitions.
- **Add memory** — a structured ground-fact drawer with an explicit relationship and
  durable source statement. It does not silently infer or apply model output.

## Local security boundary

The server binds to `127.0.0.1` by default and refuses every non-loopback host. Mutating
browser requests must be same-origin, API inputs retain the 64 KiB bound, API responses
retain the 16 MiB bound, and production responses set restrictive content, framing,
referrer, and permissions headers. Remote access is not an option in this release because
the personal workspace has no network authentication layer.

Source statements are stored through the existing journal path, including credential
redaction and retry-safe provenance. The browser never receives `LLM_API_KEY`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `REMBERO_WEB_ROOT` | Dedicated memory directory | `.rembero-web` |
| `REMBERO_WEB_NAMESPACE` | Selected namespace | `personal` |
| `REMBERO_WEB_HOST` | Bind host | `127.0.0.1` |
| `REMBERO_WEB_PORT` | Bind port | `4318` |
| `REMBERO_WEB_SEED_DEMO` | Seed the demo when empty | `true` |
| `LLM_API_KEY` | Enable custom natural-language questions | unset |

## Visual contract

The desktop and mobile references live in
`docs/assets/rembero-web-concept-desktop.png` and
`docs/assets/rembero-web-concept-mobile.png`. The implementation uses a true-white
editorial evidence desk, deep ink navigation, cobalt actions, amber provenance markers,
one primary proof frame, and code-native controls and graph text.
