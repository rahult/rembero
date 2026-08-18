import { Playground } from "./playground";

const github = "https://github.com/rahult/remembero";

export default function Home() {
  return (
    <main>
      <Playground />

      <section className="ide-afterword" aria-labelledby="afterword-title">
        <div>
          <h1 id="afterword-title">The database is the demo.</h1>
          <p>
            Add a row, run a rule, and inspect every premise. Nothing leaves the
            browser and no derived answer is written back as truth.
          </p>
        </div>
        <div className="afterword-ledger">
          <article>
            <strong>SQLite owns the rows.</strong>
            <p>Ordinary tables remain storage and transaction authority.</p>
          </article>
          <article>
            <strong>The extension owns the query.</strong>
            <p>The existing Rembero C extension is compiled into SQLite WebAssembly.</p>
          </article>
          <article>
            <strong>The proof owns the answer.</strong>
            <p>Results, proof ladders, and graphs come from one exact execution.</p>
          </article>
        </div>
      </section>

      <section className="ide-model-boundary" aria-labelledby="boundary-title">
        <div>
          <h2 id="boundary-title">Models translate. Rules decide.</h2>
          <p>
            This IDE deliberately starts after natural-language translation. SQL,
            Datalog, results, proofs, and graphs run locally with no model or API key.
          </p>
        </div>
        <ol>
          <li><span>1</span>Insert SQLite data</li>
          <li><span>2</span>Run a reviewed rule</li>
          <li><span>3</span>Inspect the support chain</li>
        </ol>
      </section>

      <section className="ide-final-cta">
        <h2>Build agents that can show their work.</h2>
        <div>
          <a className="button primary" href={github}>View the source</a>
          <a className="button secondary" href={`${github}#readme`}>Read the docs</a>
        </div>
      </section>

      <footer className="site-footer">
        <strong>rembero</strong>
        <nav aria-label="Footer navigation">
          <a href={github}>GitHub</a>
          <a href={`${github}#readme`}>Docs</a>
          <a href="https://www.npmjs.com/package/rembero">npm</a>
          <span>MIT licensed</span>
        </nav>
      </footer>
    </main>
  );
}
