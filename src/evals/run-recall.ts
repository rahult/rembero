#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../env.js';
import { DEFAULT_MODEL, OpenRouterClient } from '../llm/client.js';
import { retrieveQuestion } from '../llm/pipeline.js';
import type { QueryPromptVariant } from '../llm/prompts.js';
import { MemoryStore } from '../store/store.js';
import {
  RECALL_EVAL_CASES,
  RECALL_EVAL_PROGRAM,
  bindingRows,
  observationIsCorrect,
  scoreRecallEval,
  type RecallEvalObservation,
} from './recall.js';

interface EvalArgs {
  models: string[];
  variants: QueryPromptVariant[];
  json: boolean;
  caseIds: Set<string> | null;
}

const USAGE = `Usage: npm run eval:recall -- [options]

Options:
  --models <a,b>       OpenRouter model IDs (default: LLM_MODEL or ${DEFAULT_MODEL})
  --variants <a,b>     baseline,grounded (default: baseline,grounded)
  --cases <a,b>        Run only selected case IDs
  --json               Print machine-readable JSON
`;

function listValue(argv: string[], index: number, flag: string): string[] {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} needs a comma-separated value`);
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} needs at least one value`);
  return items;
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    models: [process.env.LLM_MODEL ?? DEFAULT_MODEL],
    variants: ['baseline', 'grounded'],
    json: false,
    caseIds: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--models') {
      args.models = listValue(argv, index, arg);
      index++;
    } else if (arg === '--variants') {
      const variants = listValue(argv, index, arg);
      if (variants.some((variant) => variant !== 'baseline' && variant !== 'grounded')) {
        throw new Error(`unknown variant: ${variants.join(', ')}`);
      }
      args.variants = variants as QueryPromptVariant[];
      index++;
    } else if (arg === '--cases') {
      args.caseIds = new Set(listValue(argv, index, arg));
      index++;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function runConfiguration(
  model: string,
  variant: QueryPromptVariant,
  caseIds: Set<string> | null,
  apiKey: string,
  baseUrl: string
): Promise<RecallEvalObservation[]> {
  const root = mkdtempSync(join(tmpdir(), 'rembero-recall-eval-'));
  try {
    const store = new MemoryStore(root);
    store.assert('default', RECALL_EVAL_PROGRAM);
    const llm = new OpenRouterClient({ apiKey, baseUrl, model });
    const cases = RECALL_EVAL_CASES.filter((testCase) =>
      caseIds === null ? true : caseIds.has(testCase.id)
    );
    const observations: RecallEvalObservation[] = [];
    for (const testCase of cases) {
      const started = performance.now();
      try {
        const result = await retrieveQuestion(
          { store, llm },
          testCase.question,
          ['default'],
          { queryPromptVariant: variant }
        );
        observations.push({
          case: testCase,
          model,
          variant,
          query: result.query,
          actualRows:
            result.query === null ? [] : bindingRows(result.bindings, result.query),
          durationMs: performance.now() - started,
        });
      } catch (error) {
        observations.push({
          case: testCase,
          model,
          variant,
          query: null,
          actualRows: [],
          durationMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return observations;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.caseIds !== null) {
    const known = new Set(RECALL_EVAL_CASES.map((testCase) => testCase.id));
    const unknown = [...args.caseIds].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown case ID: ${unknown.join(', ')}`);
  }
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is not set — add it to .env or the environment');
  const baseUrl = (process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const runs: { model: string; variant: QueryPromptVariant; score: ReturnType<typeof scoreRecallEval>; observations: RecallEvalObservation[] }[] = [];

  for (const model of args.models) {
    for (const variant of args.variants) {
      if (!args.json) console.error(`Evaluating ${model} / ${variant}...`);
      const observations = await runConfiguration(
        model,
        variant,
        args.caseIds,
        apiKey,
        baseUrl
      );
      runs.push({ model, variant, score: scoreRecallEval(observations), observations });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2));
    if (runs.some((run) => run.score.errors > 0)) process.exitCode = 1;
    return;
  }

  console.log('\nmodel | variant | cases | accuracy | precision | recall | F1 | answerability | errors | seconds');
  console.log('--- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');
  for (const run of runs) {
    console.log(
      `${run.model} | ${run.variant} | ${run.score.cases} | ${percent(run.score.accuracy)} | ${percent(run.score.precision)} | ${percent(run.score.recall)} | ${percent(run.score.f1)} | ${percent(run.score.answerabilityAccuracy)} | ${run.score.errors} | ${(run.score.durationMs / 1000).toFixed(1)}`
    );
  }

  for (const run of runs) {
    const failures = run.observations.filter((observation) => !observationIsCorrect(observation));
    if (failures.length === 0) continue;
    console.log(`\nFailures for ${run.model} / ${run.variant}:`);
    for (const failure of failures) {
      const actual = failure.actualRows.map((row) => `[${row.join(', ')}]`).join(', ') || '(none)';
      const expected = failure.case.expectedRows.map((row) => `[${row.join(', ')}]`).join(', ') || '(none)';
      console.log(`- ${failure.case.id}: query=${failure.query ?? '(unanswerable)'}; expected=${expected}; actual=${actual}${failure.error ? `; error=${failure.error}` : ''}`);
    }
  }
  if (runs.some((run) => run.score.errors > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
