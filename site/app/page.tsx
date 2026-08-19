import Image from "next/image";

const github = "https://github.com/rahult/remembero";
const playground = "/playground";
const chatMemoryLab = "/labs/chat-memory";
const groundedAgentLab = "/labs/grounded-agent";
const agentHarnessGuide = "/guides/agent-harness";

function HeroProof() {
  return (
    <div className="hero-proof" aria-label="Example proof-carrying answer">
      <div className="hero-proof-row"><span>Question</span><p>Who is collaborating on Atlas?</p></div>
      <div className="hero-proof-row"><span>Query</span><code>collaborator(Person, atlas)</code></div>
      <div className="hero-proof-row hero-answer"><span>Answer</span><p>Maya is collaborating on Atlas.</p></div>
      <div className="hero-proof-row hero-because">
        <span>Because</span>
        <ol>
          <li><b>1</b><code>project_owner(atlas, rahul)</code></li>
          <li><b>2</b><code>project_contributor(atlas, maya)</code></li>
        </ol>
      </div>
      <div className="hero-proof-source"><span>Atlas planning session · 17 Aug</span><a href={playground}>Open in playground</a></div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="marketing-home">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Remembero home">remembero</a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#product">Product</a><a href="#labs">Labs</a><a href={agentHarnessGuide}>Agent guide</a><a href={playground}>Playground</a><a href={github}>GitHub</a>
        </nav>
        <div className="header-actions">
          <a className="button primary header-try" href={playground}>Try the playground</a>
          <a className="button secondary desktop-source" href={github}>View on GitHub</a>
          <details className="mobile-menu">
            <summary aria-label="Open menu"><i /><i /><i /></summary>
            <nav aria-label="Mobile navigation"><a href="#product">Product</a><a href="#labs">Labs</a><a href={agentHarnessGuide}>Agent guide</a><a href={playground}>Playground</a><a href={github}>GitHub</a></nav>
          </details>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <h1>Memory you<br />can reason with.</h1>
          <p>Store facts and rules as readable knowledge. Ask useful questions. Get deterministic answers with the proof attached.</p>
          <div className="hero-actions"><a className="button primary" href={playground}>Try the playground</a><a className="button secondary" href={github}>View on GitHub</a></div>
          <span className="hero-boundary">Local-first by default. Logic owns the answer.</span>
        </div>
        <HeroProof />
      </section>

      <section className="difference section-dark" id="product">
        <div className="section-shell">
          <h2>Not another vector store.</h2>
          <p className="section-lede">Similarity finds nearby text. Remembero proves what follows.</p>
          <div className="difference-grid">
            <article><h3>Readable memory</h3><p>Plain-text facts, rules, and constraints.</p><pre><code>{`project_owner(atlas, rahul).
status(atlas, blocked).`}</code></pre></article>
            <article><h3>Deterministic rules</h3><p>Same knowledge. Same query. Same answer.</p><pre><code>{`needs_follow_up(Person, Project) :-
  promised_update(rahul, Person, Project),
  status(Project, blocked).`}</code></pre></article>
            <article><h3>Proof, not vibes</h3><p>Every derived answer carries its supporting claims.</p><pre><code>{`collaborator(maya, atlas)
├─ project_owner(atlas, rahul)
└─ project_contributor(atlas, maya)`}</code></pre></article>
          </div>
        </div>
      </section>

      <section className="product-showcase section" aria-labelledby="showcase-title">
        <div className="section-shell">
          <div className="showcase-heading">
            <div><h2 id="showcase-title">The database is the demo.</h2><p>Insert a SQLite row, run Datalog, then inspect the exact facts and rule behind the answer—all inside your browser.</p></div>
            <a className="button primary" href={playground}>Open the full playground</a>
          </div>
          <a className="showcase-frame" href={playground} aria-label="Open the Remembero SQLite and Datalog playground">
            <Image src="/og.png" alt="Remembero SQLite and Datalog IDE showing tables, a query, proof, and graph" width={1731} height={909} unoptimized priority />
          </a>
          <div className="showcase-ledger">
            <span><strong>SQLite owns the rows.</strong> Ordinary tables remain the storage authority.</span>
            <span><strong>Rules own the query.</strong> The C extension executes inside SQLite WebAssembly.</span>
            <span><strong>Proof owns the answer.</strong> Every result can show its complete support chain.</span>
          </div>
        </div>
      </section>

      <section className="labs-showcase section-dark" id="labs" aria-labelledby="labs-title">
        <div className="section-shell">
          <div className="labs-heading">
            <h2 id="labs-title">See what better tools do for a small model.</h2>
            <p>Three browser workbenches expose the full chain: optional Hermes 7B WebLLM inference with native tool calls, deterministic memory and policy, then SQLite + Wasm execution with the call, result, proof, and timing evidence on screen.</p>
          </div>
          <div className="lab-links">
            <a href={chatMemoryLab}>
              <span>Chat recall lab</span>
              <strong>Same small model.<br /><em>Better tool.</em></strong>
              <p>Watch Hermes 7B issue native WebLLM tool calls against one shared SQLite database: raw SQL rows in one lane, Remembero bindings and proof in the other.</p>
              <b aria-hidden="true">Open lab →</b>
            </a>
            <a href={groundedAgentLab}>
              <span>Grounded agent lab</span>
              <strong>Let the model propose.<br /><em>Let rules decide.</em></strong>
              <p>Run the same Hermes 7B model with and without memory, then watch the request facts, packet swap, gate query, rule, and proof chain stay visible while the action resolves.</p>
              <b aria-hidden="true">Open lab →</b>
            </a>
            <a href={playground}>
              <span>SQLite + Datalog playground</span>
              <strong>Mutate SQLite.<br /><em>Measure the proof.</em></strong>
              <p>Insert real rows, execute the Remembero extension inside SQLite WebAssembly, and inspect the browser-local tables, compiled rule, proof graph, and current-browser timings.</p>
              <b aria-hidden="true">Open playground →</b>
            </a>
          </div>
        </div>
      </section>

      <section className="how section" id="how-it-works">
        <div className="section-shell">
          <h2>An answer is only useful if you can inspect <em>why.</em></h2>
          <div className="steps">
            <article><div className="step-title"><b>1</b><h3>Store evidence</h3></div><p>Capture a fact with the statement it came from.</p><code>project_owner(atlas, rahul).</code></article>
            <article><div className="step-title"><b>2</b><h3>Apply reviewed rules</h3></div><p>Derive useful knowledge without storing invented conclusions.</p><code>collaborator(Person, Project) :- …</code></article>
            <article><div className="step-title"><b>3</b><h3>Return the support chain</h3></div><p>Inspect the exact claims and rules behind every answer.</p><code>answer → rule → sourced facts</code></article>
          </div>
        </div>
      </section>

      <section className="boundary section-dark">
        <div className="section-shell boundary-grid">
          <article className="model-boundary">
            <h2>Models translate.<br />Rules <em>decide.</em></h2>
            <p>Natural language can translate a question into a query. Remembero evaluates the accepted query against explicit knowledge and returns the evidence locally.</p>
            <ol className="boundary-flow"><li>Question <span>natural language</span></li><li>Translate <span>model</span></li><li>Query <span>accepted</span></li><li>Evaluate <span>rules + facts</span></li><li>Answer + evidence</li></ol>
          </article>
          <article className="integrations">
            <h2>One memory layer.<br />Three ways <em>in.</em></h2>
            <div className="integration-list"><div><strong>MCP</strong><span>Connect agents and tools through Model Context Protocol servers.</span></div><div><strong>TypeScript</strong><span>Use the typed library API inside your applications.</span></div><div><strong>CLI</strong><code>npx -y remembero</code></div></div>
          </article>
        </div>
      </section>

      <section className="final-cta section">
        <div className="section-shell final-cta-grid">
          <div><h2>Build agents that can <em>show their work.</em></h2><p>Try a real-life lab first, then open the IDE when you want to inspect the machinery.</p></div>
          <div className="final-actions"><a className="button primary" href={chatMemoryLab}>Open a lab</a><a className="button link-button" href={playground}>Open the playground <span aria-hidden="true">→</span></a></div>
        </div>
      </section>

      <footer className="site-footer">
        <strong>remembero</strong>
        <nav aria-label="Footer navigation"><a href={chatMemoryLab}>Chat lab</a><a href={groundedAgentLab}>Agent lab</a><a href={playground}>Playground</a><a href={github}>GitHub</a><a href={`${github}#readme`}>Docs</a><a href="https://www.npmjs.com/package/remembero">npm</a><span>MIT licensed</span></nav>
      </footer>
    </main>
  );
}
