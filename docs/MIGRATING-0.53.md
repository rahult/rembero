# Migrating to 0.53

Version 0.53 is additive. Existing library, CLI, MCP, SQLite, storage, and package APIs are
unchanged.

The package adds the `rembero-web` binary, a prebuilt browser client under `dist`, the
`RemberoWebService` library facade, and `startWebServer(...)`. `npm run web:dev` starts the
development console; `npm run web` builds and starts the production console.

The default `.rembero-web/` sandbox is separate from existing memory and is ignored by
Git. Set `REMBERO_WEB_ROOT` explicitly to choose another store. Non-loopback binding is
always rejected; the web console has no remote access mode in this release.

No stored format changes are required.
