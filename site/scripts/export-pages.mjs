import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const siteRoot = resolve(import.meta.dirname, "..");
const clientRoot = resolve(siteRoot, "dist/client");
const pagesRoot = resolve(siteRoot, "dist/pages");
const workerUrl = pathToFileURL(resolve(siteRoot, "dist/server/index.js"));
workerUrl.searchParams.set("static-export", `${process.pid}-${Date.now()}`);

const origin = (process.env.SITE_ORIGIN ?? "https://remembero.rahultrikha.com").replace(
  /\/$/,
  "",
);
const originUrl = new URL(origin);

const { default: worker } = await import(workerUrl.href);
const response = await worker.fetch(
  new Request(`${origin}/`, {
    headers: {
      accept: "text/html",
      host: originUrl.host,
      "x-forwarded-proto": originUrl.protocol.replace(":", ""),
    },
  }),
  { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
  { waitUntil() {}, passThroughOnException() {} },
);

if (!response.ok) {
  throw new Error(`static render failed with HTTP ${response.status}`);
}

const directionComment = `<!--
THESIS: The database is the demo; this surface refuses a marketing hero that hides the mechanism.
OWN-WORLD: True white evidence canvas, navy structural chrome, cobalt execution, amber provenance, compact sans controls, mono data, serif answers.
STORY: A database-literate visitor inserts a row, inspects SQLite, runs a prepared rule, and verifies the answer through one proof and graph.
FIRST VIEWPORT: Full-height IDE with optional guidance and schema left, data and query center, proof and graph right, lineage and native status always visible.
FORM: Guided Query Canvas with Lineage Rail; surface seed 92872415; approved comp .impeccable/mocks/guided-query-canvas.png.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`;
const html = (await response.text()).replace(
  /(<body\b[^>]*>)/i,
  `$1${directionComment}`,
);
if (!html.includes("SQLite + Datalog IDE") || !html.includes('id="playground"')) {
  throw new Error("static render is missing the product or playground bundle");
}

await rm(pagesRoot, { recursive: true, force: true });
await mkdir(pagesRoot, { recursive: true });
await cp(clientRoot, pagesRoot, { recursive: true });
await writeFile(resolve(pagesRoot, "index.html"), html);
await copyFile(resolve(pagesRoot, "index.html"), resolve(pagesRoot, "404.html"));
await writeFile(resolve(pagesRoot, ".nojekyll"), "");

console.log(`Exported GitHub Pages site for ${origin}`);
