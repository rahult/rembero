/* eslint-disable @next/next/no-html-link-for-pages -- GitHub Pages needs document navigation, not RSC prefetch. */
"use client";

import { startTransition, useEffect, useState } from "react";
import {
  GROUNDED_AGENT_SCENARIOS,
  evaluateGroundedAgentCase,
  type GroundedAgentCaseId,
  type GroundedAgentProposal,
} from "../../../lib/grounded-agent-lab";
import {
  WEB_LLM_MODEL_ID,
  WEB_LLM_MODEL_LABEL,
  WEB_LLM_VRAM_MB,
  describeBrowserModelResult,
  loadWebLlm,
  promptAvailableBrowserModel,
  promptLoadedWebLlm,
  type BrowserModelMode,
  type WebLlmProgress,
} from "../../../lib/browser-language-model";
import styles from "./grounded-agent-lab.module.css";

const github = "https://github.com/rahult/remembero";
const playground = "/playground";
const AGENT_PROMPT =
  "You are a refund triage agent. Return exactly one action token: APPROVE_REFUND or ESCALATE_HUMAN. " +
  "Do not add explanation.";

const PROMPT_TRACE_STEP_COUNT = 2;
const GROUNDED_TRACE_STEP_COUNT = 4;
const FLOW_STEPS = [
  {
    key: "request",
    label: "Read request",
    detail: "Turn the customer message into structured ticket facts.",
  },
  {
    key: "prompt",
    label: "Prompt-only",
    detail: "The model drafts an unsupported action from the request alone.",
  },
  {
    key: "recall",
    label: "Recall + rules",
    detail: "Remembero returns the facts and active policy rule.",
  },
  {
    key: "gate",
    label: "Gate",
    detail: "The deterministic decision decides whether action is allowed.",
  },
] as const;

function formatDuration(value: number | null): string {
  if (value === null) return "measuring…";
  return `${Math.max(value, 0.001).toFixed(3)} ms`;
}

function proposalFromModel(output: string): {
  outcome: string;
  action: GroundedAgentProposal;
  valid: boolean;
} {
  const normalized = output.toUpperCase();
  const approves = normalized.includes("APPROVE_REFUND");
  const escalates = normalized.includes("ESCALATE_HUMAN") || normalized.includes("HANDOFF");
  if (approves === escalates) {
    return {
      outcome: "ESCALATE TO HUMAN",
      action: "handoff",
      valid: false,
    };
  }
  if (escalates) {
    return {
      outcome: "ESCALATE TO HUMAN",
      action: "handoff",
      valid: true,
    };
  }
  return {
    outcome: "APPROVE REFUND",
    action: "approve_refund",
    valid: true,
  };
}

function stepState(index: number, visibleSteps: number): "done" | "current" | "pending" {
  if (index < visibleSteps - 1) return "done";
  if (index === visibleSteps - 1) return "current";
  return "pending";
}

function scheduleTraceAnimation(
  setPromptSteps: (value: number) => void,
  setGroundedSteps: (value: number) => void,
  reduceMotion: boolean,
  animateTrace: boolean,
  groundedStepCount: number,
): () => void {
  if (reduceMotion || !animateTrace) {
    setPromptSteps(PROMPT_TRACE_STEP_COUNT);
    setGroundedSteps(groundedStepCount);
    return () => undefined;
  }

  setPromptSteps(1);
  setGroundedSteps(1);
  const timeouts = [
    window.setTimeout(() => setPromptSteps(2), 180),
    window.setTimeout(() => setGroundedSteps(2), 240),
    window.setTimeout(() => setGroundedSteps(3), 440),
    window.setTimeout(() => setGroundedSteps(groundedStepCount), 700),
  ];

  return () => {
    for (const timeout of timeouts) window.clearTimeout(timeout);
  };
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mediaQuery.matches);
    sync();
    mediaQuery.addEventListener("change", sync);
    return () => mediaQuery.removeEventListener("change", sync);
  }, []);

  return reducedMotion;
}

export function GroundedAgentLab() {
  const [scenarioId, setScenarioId] = useState<GroundedAgentCaseId>("identity_dispute");
  const [animateTrace, setAnimateTrace] = useState(true);
  const [runVersion, setRunVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [modelMode, setModelMode] = useState<BrowserModelMode>("simulated");
  const [modelDiagnostic, setModelDiagnostic] = useState("LanguageModel not run");
  const [webLlmStatus, setWebLlmStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [webLlmProgress, setWebLlmProgress] = useState<WebLlmProgress>({
    progress: 0,
    text: `On demand · about ${(WEB_LLM_VRAM_MB / 1000).toFixed(1)} GB VRAM · weights cached by the browser`,
  });
  const [gateDurationMs, setGateDurationMs] = useState<number | null>(null);
  const [promptModelOutput, setPromptModelOutput] = useState("Not run yet");
  const [groundedModelOutput, setGroundedModelOutput] = useState("Not run yet");
  const [proposalContract, setProposalContract] = useState("Awaiting model output");
  const [promptProposalStatus, setPromptProposalStatus] = useState<
    "simulated" | "generated" | "invalid"
  >("simulated");
  const [promptProposal, setPromptProposal] = useState("APPROVE REFUND");
  const [groundedProposal, setGroundedProposal] =
    useState<GroundedAgentProposal>("approve_refund");
  const [promptStepsVisible, setPromptStepsVisible] = useState<number>(
    PROMPT_TRACE_STEP_COUNT,
  );
  const [groundedStepsVisible, setGroundedStepsVisible] = useState<number>(
    GROUNDED_TRACE_STEP_COUNT,
  );
  const reducedMotion = useReducedMotion();
  const decision = evaluateGroundedAgentCase(scenarioId, groundedProposal);
  const scenario = decision.scenario;
  const promptFunction =
    webLlmStatus === "ready"
      ? "promptLoadedWebLlm(packet)"
      : "promptAvailableBrowserModel(packet)";
  const promptTrace = ["Build no-memory packet", promptFunction] as const;
  const groundedTracePrefix = ["Build memory packet", promptFunction] as const;

  const promptOnlyRequest = [
    `Customer request: ${scenario.customerMessage}`,
    "Memory tool result: none",
  ].join("\n");

  const groundedRequest = [
    `Customer request: ${scenario.customerMessage}`,
    "Memory tool result:",
    ...scenario.recallFacts,
  ].join("\n");

  const promptPacket = [
    `Instruction: ${AGENT_PROMPT}`,
    promptOnlyRequest,
  ].join("\n");

  const groundedPacket = [
    `Instruction: ${AGENT_PROMPT}`,
    groundedRequest,
  ].join("\n");

  useEffect(() => {
    return scheduleTraceAnimation(
      setPromptStepsVisible,
      setGroundedStepsVisible,
      reducedMotion,
      animateTrace,
      GROUNDED_TRACE_STEP_COUNT,
    );
  }, [animateTrace, reducedMotion, runVersion, scenarioId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const started = performance.now();
      evaluateGroundedAgentCase(scenarioId, groundedProposal);
      setGateDurationMs(performance.now() - started);
    });
    return () => cancelAnimationFrame(frame);
  }, [groundedProposal, scenarioId]);

  async function handleRunAgents() {
    setRunning(true);
    try {
      const promptModel =
        webLlmStatus === "ready" ? promptLoadedWebLlm : promptAvailableBrowserModel;
      const promptOnly = await promptModel(
        AGENT_PROMPT,
        promptOnlyRequest,
      );
      const grounded = await promptModel(
        AGENT_PROMPT,
        groundedRequest,
      );
      if (promptOnly.status === "generated" && grounded.status === "generated") {
        const promptAction = proposalFromModel(promptOnly.text);
        const groundedAction = proposalFromModel(grounded.text);
        setPromptModelOutput(promptOnly.text);
        setGroundedModelOutput(grounded.text);
        setPromptProposalStatus(promptAction.valid ? "generated" : "invalid");
        setProposalContract(
          `prompt ${promptAction.valid ? "passed" : "failed closed"} · grounded ${groundedAction.valid ? "passed" : "failed closed"}`,
        );
        setPromptProposal(promptAction.outcome);
        setGroundedProposal(groundedAction.action);
        setModelMode(grounded.runtime === "webllm" ? "webllm" : "browser");
        setModelDiagnostic(describeBrowserModelResult(grounded));
      } else {
        const fallback = promptOnly.status === "fallback" ? promptOnly : grounded;
        setPromptProposal(scenario.promptOnlyOutcome);
        setGroundedProposal("approve_refund");
        setPromptModelOutput("Deterministic simulator fixture");
        setGroundedModelOutput("Deterministic simulator fixture");
        setProposalContract("Simulator fixture · no model output to validate");
        setPromptProposalStatus("simulated");
        setModelMode("simulated");
        setModelDiagnostic(describeBrowserModelResult(fallback));
      }
      setRunVersion((value) => value + 1);
    } finally {
      setRunning(false);
    }
  }

  async function handleLoadWebLlm() {
    setWebLlmStatus("loading");
    setWebLlmProgress({ progress: 0, text: "Preparing WebLLM download" });
    const result = await loadWebLlm(setWebLlmProgress);
    if (result.status === "ready") {
      setWebLlmStatus("ready");
      setModelMode("webllm");
      setModelDiagnostic(
        `${result.modelId} ready · loaded in ${(result.loadMs / 1000).toFixed(1)} s`,
      );
      setWebLlmProgress({ progress: 1, text: "WebLLM ready for local inference" });
      setRunVersion((value) => value + 1);
      return;
    }

    const text =
      result.reason === "webgpu_unsupported"
        ? "WebGPU is unavailable in this browser"
        : "WebLLM model loading failed";
    setWebLlmStatus("error");
    setModelMode("simulated");
    setModelDiagnostic(text);
    setWebLlmProgress({ progress: 0, text });
  }

  return (
    <section className={styles.pageShell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Remembero home">
          remembero
        </a>
        <nav className={styles.nav} aria-label="Lab navigation">
          <a className={styles.navActive} href="/#labs">
            Labs
          </a>
          <a href={playground}>Playground</a>
          <a href="/guides/agent-harness">Guide</a>
          <a href={github}>GitHub</a>
        </nav>
        <a className={styles.backHome} href="/">
          <span aria-hidden="true">←</span>
          <span>Back home</span>
        </a>
      </header>

      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1>Let the model propose. Let the gate show its work.</h1>
          <p>
            A small agent can draft the move. The request, memory recall, policy
            rule, and proof chain stay visible while the decision resolves.
          </p>
        </div>
        <div className={styles.heroStatus} aria-label="Current agent status">
          <div>
            <span>Prompt-only</span>
            <strong>{promptProposal}</strong>
          </div>
          <div>
            <span>Grounded</span>
            <strong>{decision.badgeTitle}</strong>
          </div>
          <div>
            <span>Trace mode</span>
            <strong>{animateTrace ? "Animated" : "Static"}</strong>
          </div>
          <div>
            <span>Model runtime</span>
            <strong>
              {modelMode === "webllm"
                ? WEB_LLM_MODEL_ID
                : modelMode === "browser"
                  ? "Browser local model"
                  : modelDiagnostic}
            </strong>
          </div>
          <div>
            <span>Gate eval</span>
            <strong>{formatDuration(gateDurationMs)} · current seeded case</strong>
          </div>
          <div>
            <span>Model generation</span>
            <strong>{modelDiagnostic}</strong>
          </div>
          <div>
            <span>Proposal contract</span>
            <strong>{proposalContract}</strong>
          </div>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.caseRow}>
          <span className={styles.caseLabel}>Case</span>
          <div className={styles.caseTabs} role="group" aria-label="Grounded agent cases">
            {GROUNDED_AGENT_SCENARIOS.map((entry) => {
              const selected = entry.id === scenarioId;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={running}
                  className={selected ? styles.caseTabActive : styles.caseTab}
                  onClick={() =>
                    startTransition(() => {
                      setScenarioId(entry.id);
                      setPromptProposal(entry.promptOnlyOutcome);
                      setGroundedProposal("approve_refund");
                      setPromptModelOutput("Not run yet");
                      setGroundedModelOutput("Not run yet");
                      setProposalContract("Awaiting model output");
                      setPromptProposalStatus("simulated");
                      if (webLlmStatus !== "ready") {
                        setModelMode("simulated");
                        setModelDiagnostic("LanguageModel not run");
                      }
                      setRunVersion((value) => value + 1);
                    })
                  }
                >
                  <span
                    className={styles.caseTabIcon}
                    data-selected={selected}
                    aria-hidden="true"
                  />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.controlRow}>
          <button
            type="button"
            className={styles.loadButton}
            onClick={() => void handleLoadWebLlm()}
            disabled={webLlmStatus === "loading" || webLlmStatus === "ready"}
          >
            {webLlmStatus === "loading"
              ? `Loading ${Math.round(webLlmProgress.progress * 100)}%`
              : webLlmStatus === "ready"
                ? "7B WebLLM ready"
                : `Load ${WEB_LLM_MODEL_LABEL}`}
          </button>
          <button
            type="button"
            className={styles.runButton}
            onClick={() => void handleRunAgents()}
            disabled={running}
          >
            <span className={styles.playMark} aria-hidden="true" />
            <span>{running ? "Running local model…" : "Run both agents"}</span>
          </button>
          <label className={styles.animateToggle}>
            <input
              type="checkbox"
              checked={animateTrace}
              onChange={(event) => setAnimateTrace(event.target.checked)}
            />
            <span>Animate trace</span>
          </label>
          <span className={styles.modelLoadStatus} aria-live="polite">
            {webLlmProgress.text}
          </span>
        </div>
      </div>

      <section className={styles.flowStrip} aria-label="Execution flow">
        {FLOW_STEPS.map((step) => (
          <article key={step.key}>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </article>
        ))}
      </section>

      <section className={styles.ledgerStrip} aria-label="Developer evidence ledger">
        <article className={styles.ledgerCard}>
          <span>Request facts</span>
          <strong>{scenario.requestHeadline}</strong>
          <p>{scenario.customerMessage}</p>
          <ul className={styles.ledgerList}>
            {scenario.recallFacts.map((fact) => (
              <li key={fact}>
                <code>{fact}</code>
              </li>
            ))}
          </ul>
        </article>
        <article className={styles.ledgerCard}>
          <span>Prompt packet</span>
          <strong>
            {promptProposalStatus === "generated"
              ? "Model proposal · ungoverned"
              : promptProposalStatus === "invalid"
                ? "Invalid output · failed closed"
                : "Simulator proposal · ungoverned"}
          </strong>
          <pre className={styles.ledgerPacket}>{promptPacket}</pre>
          <div className={styles.modelOutput}>
            <span>Raw model output</span>
            <code>{promptModelOutput}</code>
          </div>
        </article>
        <article className={styles.ledgerCard}>
          <span>Grounded packet</span>
          <strong>{scenario.recallFacts.length} recalled facts</strong>
          <pre className={styles.ledgerPacket}>{groundedPacket}</pre>
          <div className={styles.modelOutput}>
            <span>Raw model output</span>
            <code>{groundedModelOutput}</code>
          </div>
        </article>
        <article className={styles.ledgerCard}>
          <span>Gate proof</span>
          <strong>{decision.badgeTitle}</strong>
          <dl className={styles.ledgerProofMeta}>
            <div>
              <dt>Query</dt>
              <dd>{decision.decisionQuery}</dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd>{decision.activeRule}</dd>
            </div>
          </dl>
          <ol className={styles.ledgerProof}>
            {decision.proofChain.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className={styles.ledgerNote}>{proposalContract}</p>
        </article>
      </section>

      <div className={styles.comparisonShell}>
        <section className={styles.requestPanel} aria-labelledby="incoming-request-title">
          <div className={styles.panelHeader}>
            <div>
              <h2 id="incoming-request-title">Incoming request</h2>
              <p>{scenario.requestHeadline}</p>
            </div>
            <span className={styles.panelBadge}>Request</span>
          </div>

          <div className={styles.customerBox}>
            <span>Customer message</span>
            <p>{scenario.customerMessage}</p>
          </div>

          <div className={styles.panelSection}>
            <h3>Structured facts</h3>
            <ul className={styles.factList}>
              {scenario.recallFacts.map((fact) => (
                <li key={fact}>
                  <code>{fact}</code>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          className={`${styles.agentPanel} ${styles.promptPanel}`}
          aria-labelledby="prompt-only-title"
        >
          <div className={styles.panelHeader}>
            <div>
              <h2 id="prompt-only-title">Prompt-only agent</h2>
              <p>Small model · no tools</p>
            </div>
            <span className={styles.panelBadge}>Proposal</span>
          </div>

          <div className={styles.trace}>
            <span className={styles.traceLabel}>Trace</span>
            <ol>
              {promptTrace.map((label, index) => {
                const state = stepState(index, promptStepsVisible);
                return (
                  <li key={label} className={styles[`trace${state}`]}>
                    <span aria-hidden="true" />
                    <strong>{label}</strong>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className={styles.outcomeWrap}>
            <span>Outcome</span>
            <div className={styles.promptOutcome}>
              <strong>{promptProposal}</strong>
              <p>
                <span aria-hidden="true">⊗</span>
                <span>
                  {promptProposalStatus === "generated"
                    ? "ungoverned"
                    : promptProposalStatus === "invalid"
                      ? "failed closed"
                      : "simulated · ungoverned"}
                </span>
              </p>
            </div>
          </div>
        </section>

        <section
          className={`${styles.agentPanel} ${styles.groundedPanel}`}
          aria-labelledby="grounded-agent-title"
        >
          <div className={styles.panelHeader}>
            <div>
              <h2 id="grounded-agent-title">Grounded agent</h2>
              <p>Same model · memory + rules</p>
            </div>
            <span className={styles.panelBadge}>Grounded</span>
          </div>

          <div className={styles.trace}>
            <span className={styles.traceLabel}>Trace</span>
            <ol>
              {[
                ...groundedTracePrefix,
                `proposal: ${groundedProposal}`,
                "evaluateGroundedAgentCase(proposal)",
              ].map((label, index) => {
                const state = stepState(index, groundedStepsVisible);
                return (
                  <li key={label} className={styles[`trace${state}`]}>
                    <span aria-hidden="true" />
                    <strong>{label}</strong>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className={styles.outcomeWrap}>
            <span>Outcome</span>
            <div
              className={
                decision.status === "approve"
                  ? styles.groundedOutcomeApprove
                  : styles.groundedOutcomeEscalate
              }
            >
              <strong>{decision.outcome}</strong>
            </div>
          </div>
        </section>

        <aside className={styles.proofPanel} aria-labelledby="decision-proof-title">
          <div className={styles.proofHeading}>
            <div>
              <h2 id="decision-proof-title">Decision proof</h2>
              <p>
                Deterministic gate · {formatDuration(gateDurationMs)} for this case.
              </p>
            </div>
            <span className={styles.panelBadge}>Proof</span>
          </div>

          <div className={styles.proofSection}>
            <span>Facts</span>
            <ul className={styles.factList}>
              {scenario.recallFacts.map((fact) => (
                <li key={fact}>
                  <code>{fact}</code>
                </li>
              ))}
              <li>
                <code>{decision.proposalFact}</code>
              </li>
            </ul>
          </div>

          <div className={styles.proofSection}>
            <span>Active rule</span>
            <pre>{decision.activeRule}</pre>
          </div>

          <div className={styles.proofSection}>
            <span>Rule evaluation</span>
            <p className={styles.evaluationLine}>
              <code>{decision.decisionQuery}</code>
              <span aria-hidden="true">↳</span>
              <strong>{decision.evaluationResult ? "true" : "false"}</strong>
            </p>
          </div>

          <div className={styles.proofSection}>
            <span>Proof chain</span>
            <ol className={styles.proofChain}>
              {decision.proofChain.map((step) => (
                <li key={step}>
                  <code>{step}</code>
                </li>
              ))}
            </ol>
          </div>

          <div className={styles.decisionCard}>
            <strong>{decision.badgeTitle}</strong>
            <p>{decision.badgeBody}</p>
          </div>
        </aside>
      </div>

      <section className={styles.thesis} aria-labelledby="authority-title">
        <h2 id="authority-title">The model never gets mutation authority.</h2>
        <div className={styles.thesisGrid}>
          <article>
            <span className={styles.thesisStep}>Proposal</span>
            <strong>Prompt-only agent</strong>
            <p>The model reads the request and proposes what it wants to do.</p>
          </article>
          <article>
            <span className={styles.thesisStep}>Gate</span>
            <strong>Deterministic policy</strong>
            <p>
              Grounded rules and memory evaluate the proposal and decide: approve,
              block, or escalate.
            </p>
          </article>
          <article>
            <span className={styles.thesisStep}>Action</span>
            <strong>Auditable result</strong>
            <p>
              Only the gate&apos;s decision can produce an action. Every decision is
              backed by facts and rules you can inspect.
            </p>
          </article>
        </div>
      </section>

      <p className={styles.footnote}>
        {modelMode === "webllm"
          ? `Model proposals were generated locally by ${WEB_LLM_MODEL_ID}. Remembero memory, rule evaluation, and proof are real and run here too.`
          : modelMode === "browser"
            ? "Model proposals were generated by this browser’s local language model. Remembero memory, rule evaluation, and proof are real and run here too."
            : `Model proposals use the deterministic simulator (${modelDiagnostic}). Remembero memory, rule evaluation, and proof are real and run in this browser.`}
      </p>
    </section>
  );
}
