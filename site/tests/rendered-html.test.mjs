import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Rembero marketing homepage with playground navigation", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Rembero — Memory you can reason with<\/title>/i);
  assert.match(html, /Memory you(?:<br\/>|\s)+can reason with\./);
  assert.match(html, /Not another vector store\./);
  assert.match(html, /The database is the demo\./);
  assert.match(html, /Models translate\./);
  assert.match(html, /Build agents that can/);
  assert.match(html, /href="\/playground"/);
  assert.match(html, /http:\/\/localhost(?::3000)?\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders the full SQLite IDE on the playground route", async () => {
  const response = await render("/playground");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rembero Playground — SQLite \+ Datalog IDE<\/title>/i);
  assert.match(html, /SQLite \+ Datalog IDE/);
  assert.match(html, /Get to the proof/);
  assert.match(html, /Insert SQLite row/);
  assert.match(html, /Who needs a follow-up\?/);
  assert.match(html, /Why this is true/);
  assert.match(html, /Query graph/);
  assert.match(html, /href="\/"[^>]*>Home/);
});

test("playground uses the statically linked SQLite extension and remains browser-contained", async () => {
  const [playground, ide, demo, adapter, page, playgroundPage, packageJson, og] = await Promise.all([
    readFile(new URL("../app/playground.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/sqlite-ide.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/ide-demo.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sqlite-wasm.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/playground/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(playground, /^"use client";/);
  assert.match(playground, /<SqliteIde/);
  assert.match(ide, /openBrowserDatalogDatabase/);
  assert.match(ide, /datalogSql/);
  assert.match(ide, /datalogQuery/);
  assert.match(ide, /datalogExplain/);
  assert.match(ide, /Insert SQLite row/);
  assert.match(ide, /Why this is true/);
  assert.match(ide, /Query graph/);
  assert.doesNotMatch(ide, /localStorage|sessionStorage|document\.cookie/);
  assert.match(adapter, /new Worker\(/);
  assert.match(adapter, /sqlite3-worker1-promiser\.mjs/);
  assert.match(adapter, /SELECT datalog_query\(\?\)/);
  assert.match(adapter, /OMIT_LOAD_EXTENSION/);
  assert.match(demo, /CREATE TABLE project_owner/);
  assert.match(demo, /needs_follow_up/);
  assert.match(demo, /reachable/);
  assert.match(page, /href=\{playground\}/);
  assert.match(playgroundPage, /<Playground \/>/);
  assert.doesNotMatch(`${page}\n${playgroundPage}\n${ide}`, /from "next\/link"/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.equal(og.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("GitHub Pages export is self-contained when present", async () => {
  const exported = new URL("../dist/pages/index.html", import.meta.url);
  const exportedPlayground = new URL("../dist/pages/playground/index.html", import.meta.url);
  await access(exported);
  await access(exportedPlayground);
  const [html, playgroundHtml] = await Promise.all([
    readFile(exported, "utf8"),
    readFile(exportedPlayground, "utf8"),
  ]);
  assert.match(html, /Memory you(?:<br\/>|\s)+can reason with\./);
  assert.match(html, /href="\/playground"/);
  assert.match(playgroundHtml, /SQLite \+ Datalog IDE/);
  assert.match(playgroundHtml, /The database is the demo\./);
  for (const rendered of [html, playgroundHtml]) {
    assert.match(rendered, /href="\/_next\/static\/css\//);
    assert.match(rendered, /src="\/_next\/static\/chunks\//);
    assert.match(rendered, /https:\/\/remembero\.rahultrikha\.com\/og\.png/);
  }
  await access(new URL("../dist/pages/.nojekyll", import.meta.url));
  await access(new URL("../dist/pages/og.png", import.meta.url));
  await access(new URL("../dist/pages/sqlite-wasm/sqlite3.wasm", import.meta.url));
});

test("SQLite Wasm contains the pinned Rembero extension build", async () => {
  const assetRoot = new URL("../public/sqlite-wasm/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", assetRoot), "utf8"),
  );
  assert.equal(manifest.format, "rembero.sqlite-wasm.v1");
  assert.equal(manifest.sqlite.version, "3.53.4");
  assert.equal(manifest.extension.dynamicallyLoaded, false);
  assert.equal(
    manifest.extension.registration,
    "sqlite3_auto_extension(sqlite3_rembero_init)",
  );

  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const contents = await readFile(new URL(name, assetRoot));
    assert.equal(contents.byteLength, expected.bytes, `${name} byte length`);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expected.sha256,
      `${name} digest`,
    );
  }

  const sourceRoot = new URL("../../native/", import.meta.url);
  for (const [name, expected] of Object.entries(manifest.extension.sources)) {
    const contents = await readFile(new URL(name, sourceRoot));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expected.sha256,
      `${name} source digest`,
    );
  }

  const wasm = await readFile(new URL("sqlite3.wasm", assetRoot));
  assert.equal(wasm.subarray(0, 4).toString("hex"), "0061736d");
  for (const functionName of ["datalog_sql", "datalog_query", "datalog_explain"]) {
    assert.ok(wasm.includes(Buffer.from(functionName)), `${functionName} is linked`);
  }
});
