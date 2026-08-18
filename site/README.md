# Rembero product site and playground

The hosted product site at `/` and browser-contained proof playground at `/playground` for
[Rembero](https://github.com/rahult/remembero).

The playground runs SQLite 3.53.4 as WebAssembly with Rembero's C extension linked into
the same binary. It uses an in-memory Atlas fixture, performs no model calls or remote
mutations, stores no browser data, and resets on refresh.

```bash
npm install
npm run dev
npm test
```

`npm run build:pages` creates the static artifact published by GitHub Pages at
[remembero.rahultrikha.com](http://remembero.rahultrikha.com/). D1, R2, and the former
ChatGPT Sites deployment are intentionally absent.
