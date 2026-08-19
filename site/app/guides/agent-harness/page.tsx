/* eslint-disable @next/next/no-html-link-for-pages -- Static export uses document navigation. */

import type { Metadata } from "next";
import styles from "./guide.module.css";

const githubGuide =
  "https://github.com/rahult/remembero/blob/main/docs/AGENT-HARNESS.md";
const githubScorecard =
  "https://github.com/rahult/remembero/blob/main/docs/AGENT-DATABASE-SCORECARD.md";
const lab = "/labs/chat-memory";
const playground = "/playground";

const toolSchema = `const queryTool = {
  type: "function",
  function: {
    name: "Query",
    description:
      "Query governed memory and return bindings, sources, and proof.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
} as const;`;

const modelCall = `const first = await model.complete({
  messages: [{
    role: "user",
    content: [
      "Call Query exactly once with the user's question.",
      "Do not answer until the tool result is available.",
      \`Question: \${question}\`
    ].join("\\n")
  }],
  tools: [queryTool],
  toolChoice: {
    type: "function",
    function: { name: "Query" }
  }
});`;

const rememberoCall = `const result = await remembero.callTool(
  "recall_explain",
  {
    question: validatedQuery,
    namespaces: ["agent"],
    answerMode: "evidence",
    proofLimit: 4
  }
);`;

const finalPrompt = `const final = await model.complete({
  messages: [
    {
      role: "system",
      content:
        "Answer using only TOOL_RESULT. Cite bindings and sources. " +
        "If status is not answered, return an explicit non-answer."
    },
    {
      role: "user",
      content: [
        \`QUESTION: \${question}\`,
        \`TOOL_CALL: \${JSON.stringify(first.toolCall)}\`,
        \`TOOL_RESULT: \${JSON.stringify(result)}\`
      ].join("\\n")
    }
  ]
});`;

const mcpConfig = `{
  "mcpServers": {
    "remembero": {
      "command": "npx",
      "args": ["-y", "remembero", "serve"],
      "env": {
        "REMBERO_HOME": "/absolute/path/to/agent-memory"
      }
    }
  }
}`;

export const metadata: Metadata = {
  title: "Remembero Guide — Add proof-carrying memory to an agent harness",
  description:
    "A framework-neutral guide to integrating Remembero tools, proof, validation, and review gates into an agent harness.",
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className={styles.codeBlock}>
      <code>{children}</code>
    </pre>
  );
}

export default function AgentHarnessGuide() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Remembero home">
          remembero
        </a>
        <nav aria-label="Guide navigation">
          <a href={lab}>Live lab</a>
          <a href={playground}>Playground</a>
          <a href={githubGuide}>Full guide</a>
        </nav>
      </header>

      <section className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Agent harness integration</span>
          <h1>Add proof-carrying memory without dumping memory into the prompt.</h1>
          <p>
            Give the model one bounded tool. Let Remembero own retrieval and proof.
            Validate the call, return only the tool result, and keep writes behind review.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href={githubGuide}>
              Copy the complete guide
            </a>
            <a className={styles.secondaryAction} href={lab}>
              Inspect the live trace
            </a>
          </div>
        </div>

        <ol className={styles.loop} aria-label="Agent tool loop">
          <li><strong>1</strong><span>User question</span></li>
          <li><strong>2</strong><span>Model calls Query</span></li>
          <li><strong>3</strong><span>Harness validates</span></li>
          <li><strong>4</strong><span>Remembero returns proof</span></li>
          <li><strong>5</strong><span>Model phrases the answer</span></li>
          <li><strong>6</strong><span>Contract accepts or blocks</span></li>
        </ol>
      </section>

      <section className={styles.quickStart} aria-labelledby="quick-start-title">
        <div className={styles.sectionHeading}>
          <span>Fastest path</span>
          <h2 id="quick-start-title">Start Remembero as an MCP server.</h2>
          <p>
            Use MCP when your harness already has a tool registry. Raw query and proof
            tools work without an LLM key; natural-language recall uses your configured provider.
          </p>
        </div>
        <div className={styles.splitCode}>
          <article>
            <h3>Start the server</h3>
            <CodeBlock>{`npm install -g remembero\nremembero serve`}</CodeBlock>
          </article>
          <article>
            <h3>Register it</h3>
            <CodeBlock>{mcpConfig}</CodeBlock>
          </article>
        </div>
      </section>

      <section className={styles.steps} aria-labelledby="implementation-title">
        <div className={styles.sectionHeading}>
          <span>Golden path</span>
          <h2 id="implementation-title">Wire one narrow tool loop.</h2>
          <p>
            These four pieces map to OpenAI-compatible clients, local WebLLM, LangGraph-style
            nodes, custom orchestrators, and most agent harnesses.
          </p>
        </div>

        <article className={styles.step}>
          <div className={styles.stepNumber}>01</div>
          <div className={styles.stepCopy}>
            <h3>Expose one semantic Query tool</h3>
            <p>
              Keep namespaces, database paths, limits, and mutation controls in trusted
              application configuration—not in model arguments.
            </p>
          </div>
          <CodeBlock>{toolSchema}</CodeBlock>
        </article>

        <article className={styles.step}>
          <div className={styles.stepNumber}>02</div>
          <div className={styles.stepCopy}>
            <h3>Ask the model to call it</h3>
            <p>
              The first prompt contains the user question and tool schema only. It must not
              contain facts, rows, rules, or the expected answer.
            </p>
          </div>
          <CodeBlock>{modelCall}</CodeBlock>
        </article>

        <article className={styles.step}>
          <div className={styles.stepNumber}>03</div>
          <div className={styles.stepCopy}>
            <h3>Validate, then execute Remembero</h3>
            <p>
              Reject unknown tool names, changed questions, oversized inputs, and unauthorized
              namespaces before any tool executes.
            </p>
          </div>
          <CodeBlock>{rememberoCall}</CodeBlock>
        </article>

        <article className={styles.step}>
          <div className={styles.stepNumber}>04</div>
          <div className={styles.stepCopy}>
            <h3>Return only the tool evidence</h3>
            <p>
              The final prompt receives the validated call and bounded tool result. A
              deterministic contract checks that the answer agrees with its bindings and proof.
            </p>
          </div>
          <CodeBlock>{finalPrompt}</CodeBlock>
        </article>
      </section>

      <section className={styles.choices} aria-labelledby="choose-tool-title">
        <div className={styles.sectionHeading}>
          <span>Choose the read surface</span>
          <h2 id="choose-tool-title">Natural recall or governed application query?</h2>
        </div>
        <div className={styles.choiceGrid}>
          <article>
            <span>General memory</span>
            <h3>recall_explain</h3>
            <p>
              Accepts a natural-language question and returns status, generated query,
              bindings, proof, durable sources, and a query-scoped graph.
            </p>
          </article>
          <article>
            <span>Governed workflow</span>
            <h3>explain_query</h3>
            <p>
              Trusted code selects an allowlisted Datalog relation. The model never authors SQL,
              chooses namespaces, or broadens its own authority.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.boundaries} aria-labelledby="boundary-title">
        <div className={styles.sectionHeading}>
          <span>Ship gate</span>
          <h2 id="boundary-title">Fail closed at every boundary.</h2>
        </div>
        <ul>
          <li>Allowlist tool names and validate arguments before execution.</li>
          <li>Return explicit non-answers for empty, unsupported, or budget-exhausted recall.</li>
          <li>Bound namespaces, result size, proof depth, and execution time in trusted code.</li>
          <li>Check final prose against returned bindings and required grounded relationships.</li>
          <li>Use propose_memory, typed review, and apply_memory_proposal for accepted writes.</li>
          <li>Attach a caller-stable opId to reviewed mutations so retries are idempotent.</li>
        </ul>
      </section>

      <section className={styles.scorecard} aria-labelledby="scorecard-title">
        <div className={styles.sectionHeading}>
          <span>Executable evidence</span>
          <h2 id="scorecard-title">Gate the database, not the marketing claim.</h2>
          <p>
            Run one command to verify structured accuracy, proof citations, stale leakage,
            engine latency, a real stdio MCP round trip, clean installation, million-fact
            memory use, and a pinned external retrieval comparison.
          </p>
        </div>
        <div className={styles.scorecardGrid}>
          <strong><span>Exact answers</span>100%</strong>
          <strong><span>Citation recall</span>100%</strong>
          <strong><span>Engine p95</span>0.54 ms</strong>
          <strong><span>MCP explain</span>7.95 ms</strong>
          <strong><span>Scale gate</span>100k facts</strong>
          <strong><span>Scale query p95</span>81.70 ms</strong>
          <strong><span>Million-fact gate</span>1.01 s · 2.15 GiB</strong>
          <strong><span>Model calls</span>0</strong>
          <strong><span>API keys</span>0</strong>
          <strong><span>Natural recall</span>$0.000644 avg</strong>
          <strong><span>Natural write</span>$0.000220 avg</strong>
          <strong><span>Luna cost lead</span>about 15x</strong>
          <strong><span>Cold npm install</span>5.19 s</strong>
          <strong><span>First proof query</span>95.46 ms</strong>
          <strong><span>Top retrieval group</span>4 stacks · 100% R@k</strong>
          <strong><span>Remembero precision</span>100% P@k</strong>
          <strong><span>Vector precision</span>88.6% P@k</strong>
          <strong><span>Mem0 formation</span>$0.044 · 118 calls</strong>
          <strong><span>Graphiti retrieval</span>44.0% R@k</strong>
          <strong><span>Graphiti formation</span>$0.0379 · 275 calls</strong>
          <strong><span>LongMemEval-S</span>500 questions</strong>
          <strong><span>Broad Recall@5</span>83.27%</strong>
          <strong><span>Broad MRR</span>80.96%</strong>
          <strong><span>Broad retrieval p95</span>10.78 ms</strong>
          <strong><span>Preference Recall@5</span>43.3 → 66.7%</strong>
          <strong><span>Held-out semantic MRR</span>45.6%</strong>
          <strong><span>Semantic route cost</span>$0.000364 avg</strong>
          <strong><span>Restart cache</span>32 → 9 tokens</strong>
        </div>
        <CodeBlock>{"npm run bench:agent-db:check\nnpm run bench:agent-db:scale -- --check\nnpm run bench:agent-db:install:check\nnpm run bench:agent-db:million\nnpm run bench:agent-db:cost\nnpm run bench:longmemeval\nnpm run bench:longmemeval:semantic # live embedding cost\nnpm run bench:memory:external\nnpm run bench:memory:mem0 # live provider cost\nnpm run bench:memory:graphiti # live provider cost"}</CodeBlock>
        <a className={styles.scorecardLink} href={githubScorecard}>
          Read the scorecard and evidence limits →
        </a>
      </section>

      <section className={styles.footerCta}>
        <div>
          <span>See every boundary</span>
          <h2>Run the live model → tool → SQLite → proof trace.</h2>
        </div>
        <a className={styles.primaryAction} href={lab}>Open the chat-memory lab</a>
      </section>
    </main>
  );
}
