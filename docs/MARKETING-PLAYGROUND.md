# Hosted marketing playground

Remembero's product marketing site and deterministic browser playground are deployed at:

<http://remembero.rahultrikha.com/>

The current Sites deployment is private and uses Sign in with ChatGPT owner access. The
site can be made public through an explicit access-policy change when desired.

## What the public-facing experience proves

- supported queries execute through the actual browser-safe Remembero Datalog engine;
- derived answers show their exact leaf claims, authored rule, and fictional source;
- the gift question returns an explicit non-answer and visibly separate related context;
- adding `prefers_gift(maya, notebook).` is session-only and changes that query to a
  directly supported answer; and
- reset restores the immutable fictional Atlas fixture.

No model, API route, D1 database, R2 bucket, cookie, browser storage, or private Remembero
store participates. Preset questions map visibly to canonical Datalog queries. The demo
bundles only `src/engine/index.ts` and its pure engine dependencies; Node-backed store,
source, SQLite, and server modules stay outside the hosted client.

## Source

The deployable Sites/vinext project is under `site/`. Its `.openai/hosting.json` retains
the opaque Sites project ID with D1 and R2 disabled. The committed design references are:

- `docs/assets/rembero-marketing-hero-concept.png`
- `docs/assets/rembero-marketing-playground-concept.png`
- `docs/assets/rembero-marketing-lower-concept.png`
- `docs/assets/rembero-marketing-mobile-concept.png`

The social card is generated specifically for the finished site at `site/public/og.png`.
