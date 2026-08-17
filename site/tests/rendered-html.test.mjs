import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("server-renders the complete Rembero marketing and playground surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Rembero — Memory you can reason with<\/title>/i);
  assert.match(html, /Memory you(?:<br\/>|\s)+can reason with\./);
  assert.match(html, /Not another vector store\./);
  assert.match(html, /Try a memory that can explain itself\./);
  assert.match(html, /Who is collaborating on Atlas\?/);
  assert.match(html, /Maya is collaborating on Atlas\./);
  assert.match(html, /Models translate\./);
  assert.match(html, /Build agents that can/);
  assert.match(html, /http:\/\/localhost(?::3000)?\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("playground bundles the real engine and remains browser-contained", async () => {
  const [playground, demo, adapter, page, packageJson, og] = await Promise.all([
    readFile(new URL("../app/playground.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/demo.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(playground, /^"use client";/);
  assert.match(playground, /runDemo/);
  assert.match(playground, /Session-only/);
  assert.match(playground, /Nothing is saved or sent/);
  assert.doesNotMatch(playground, /fetch\(|localStorage|sessionStorage|document\.cookie/);
  assert.match(adapter, /src\/engine\/index\.js/);
  assert.match(demo, /evaluateQuerySpecWithProof/);
  assert.match(demo, /maxFacts:\s*100/);
  assert.match(demo, /prefers_gift\(maya, Gift\)/);
  assert.match(playground, /Related context, not an answer/);
  assert.match(page, /<Playground \/>/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.equal(og.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});
