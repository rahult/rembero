"use client";

import { useState } from "react";
import {
  BASE_PROGRAM,
  DEMO_QUESTIONS,
  SESSION_GIFT_FACT,
  runDemo,
  type DemoQuestionId,
  type DemoResult,
} from "../lib/demo";

function initialResult(): DemoResult {
  return runDemo(BASE_PROGRAM, "collaborator");
}

export function Playground() {
  const [program, setProgram] = useState(BASE_PROGRAM);
  const [selected, setSelected] = useState<DemoQuestionId>("collaborator");
  const [result, setResult] = useState(initialResult);
  const [error, setError] = useState<string | null>(null);

  function run(id = selected, source = program) {
    try {
      setResult(runDemo(source, id));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  function addGiftFact() {
    const next = program.includes(SESSION_GIFT_FACT)
      ? program
      : `${program.trim()}\n${SESSION_GIFT_FACT}\n`;
    setProgram(next);
    setSelected("gift");
    run("gift", next);
  }

  function reset() {
    setProgram(BASE_PROGRAM);
    setSelected("collaborator");
    setResult(initialResult());
    setError(null);
  }

  return (
    <section className="playground section" id="playground" aria-labelledby="playground-title">
      <div className="section-shell playground-shell">
        <div className="playground-intro">
          <h2 id="playground-title">Try a memory that can explain itself.</h2>
          <p>Sample knowledge runs in this browser. Nothing is saved or sent.</p>
          <div className="question-list" aria-label="Demo questions">
            {DEMO_QUESTIONS.map((question) => (
              <button
                key={question.id}
                className={selected === question.id ? "question-button active" : "question-button"}
                type="button"
                onClick={() => setSelected(question.id)}
                aria-pressed={selected === question.id}
              >
                <span className="question-marker" aria-hidden="true">
                  {selected === question.id ? "✓" : "?"}
                </span>
                <span>{question.label}</span>
              </button>
            ))}
          </div>
          <button className="button primary run-button" type="button" onClick={() => run()}>
            Run query <span aria-hidden="true">→</span>
          </button>
          <p className="playground-disclosure">
            Fixed presets map to canonical Datalog queries. No model is called.
          </p>
        </div>

        <div
          className={result.status === "supported" ? "result-panel" : "result-panel not-proven"}
          aria-live="polite"
          data-testid="playground-result"
        >
          <div className="result-status-row">
            <span>{result.status === "supported" ? "Supported" : "Not proven"}</span>
            <span>Runs in your browser · sample data</span>
          </div>
          <div className="result-block">
            <span className="field-label">Query</span>
            <code>{result.question.query}</code>
          </div>
          <div className="result-block answer-block">
            <span className="field-label">Answer</span>
            <p>{result.answer}</p>
          </div>

          {result.status === "supported" ? (
            <>
              <div className="result-block">
                <span className="field-label">Because</span>
                <ol className="proof-list">
                  {result.claims.map((claim, index) => (
                    <li key={claim}>
                      <span>{index + 1}</span>
                      <code>{claim.replace(/\.$/, "")}</code>
                    </li>
                  ))}
                </ol>
              </div>
              {result.rule ? (
                <div className="result-block rule-block">
                  <span className="field-label">Rule</span>
                  <code>{result.rule}</code>
                </div>
              ) : null}
              {result.source ? (
                <div className="result-source">
                  <span>Source</span>
                  <strong>{result.source}</strong>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="result-block why-block">
                <span className="field-label">Why not</span>
                <code>{result.whyNot}</code>
                <p>Nothing in this sample snapshot proves it.</p>
              </div>
              <div className="related-context">
                <h3>Related context, not an answer</h3>
                <ul>
                  {result.related.map((item) => (
                    <li key={item.clause}>
                      <code>{item.clause}</code>
                      <span>{item.context}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <button className="button secondary add-fact-button" type="button" onClick={addGiftFact}>
                Add sourced gift fact
              </button>
            </>
          )}

          {error ? <p className="playground-error">{error}</p> : null}
          <div className="session-controls">
            <span>Session-only · refresh or reset to clear</span>
            <button type="button" onClick={reset}>Reset sample memory</button>
          </div>
        </div>
      </div>
    </section>
  );
}
