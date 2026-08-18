# Rembero marketing playground

The hosted product site and browser-contained proof playground for
[Rembero](https://github.com/rahult/remembero).

The playground bundles only Rembero's pure TypeScript Datalog engine. It uses an immutable
fictional Atlas fixture, performs no network or model calls, stores no browser data, and
resets on refresh.

```bash
npm install
npm run dev
npm test
```

The Sites deployment uses the vinext/Cloudflare-compatible output described by
`.openai/hosting.json`. D1 and R2 are intentionally disabled.
