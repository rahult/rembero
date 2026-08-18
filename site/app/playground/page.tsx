/* eslint-disable @next/next/no-html-link-for-pages -- GitHub Pages needs document navigation, not RSC prefetch. */
import type { Metadata } from "next";
import { Playground } from "../playground";

const github = "https://github.com/rahult/remembero";

export const metadata: Metadata = {
  title: "Remembero Playground — SQLite + Datalog IDE",
  description: "Run the Remembero SQLite extension in your browser and inspect exact results, proofs, lineage, and graphs.",
};

export default function PlaygroundPage() {
  return (
    <main>
      <Playground />
      <section className="ide-afterword" aria-labelledby="afterword-title">
        <div><h1 id="afterword-title">The database is the demo.</h1><p>Add a row, run a rule, and inspect every premise. Nothing leaves the browser and no derived answer is written back as truth.</p></div>
        <div className="afterword-ledger">
          <article><strong>SQLite owns the rows.</strong><p>Ordinary tables remain storage and transaction authority.</p></article>
          <article><strong>The extension owns the query.</strong><p>The Remembero C extension is compiled into SQLite WebAssembly.</p></article>
          <article><strong>The proof owns the answer.</strong><p>Results, proof ladders, and graphs come from one exact execution.</p></article>
        </div>
      </section>
      <section className="ide-final-cta"><h2>Build agents that can show their work.</h2><div><a className="button primary" href={github}>View the source</a><a className="button secondary" href="/">Return to the main site</a></div></section>
    </main>
  );
}
