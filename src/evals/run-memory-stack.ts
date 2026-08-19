#!/usr/bin/env node
import {
  createDirectFactAdapter,
  createExternalCommandAdapter,
  createLexicalAdapter,
  createRecencyAdapter,
  createRemberoMemoryAdapter,
} from './memory-stack-adapters.js';
import type { MemoryStackAdapter } from './memory-stack-contract.js';
import { loadExternalAdapterManifest } from './memory-stack-external.js';
import {
  MEMORY_STACK_CASES,
  MEMORY_STACK_LABELS,
  MEMORY_STACK_SUITE,
} from './memory-stack-fixtures.js';
import { runMemoryStackBenchmark } from './memory-stack-score.js';

interface Args {
  adapters: string[];
  cases: Set<string> | null;
  json: boolean;
  check: boolean;
  external: Array<{ id: string; executable: string }>;
  externalManifests: string[];
}

const USAGE = `Usage: npm run bench:memory -- [options]

Options:
  --adapters <list>       rembero,direct,lexical,recency (default: all)
  --cases <list>          Run selected case IDs
  --external <id>=<path>  Run an isolated v1 JSON adapter executable
  --external-manifest <path>
                          Run a pinned adapter with declared capabilities
  --json                  Print machine-readable output
  --check                 Require a perfect Remembero conformance run
`;

function value(argv: string[], index: number, flag: string): string {
  const result = argv[index + 1];
  if (result === undefined || result.trim() === '') throw new Error(`${flag} needs a value`);
  return result;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    adapters: ['rembero', 'direct', 'lexical', 'recency'],
    cases: null,
    json: false,
    check: false,
    external: [],
    externalManifests: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--adapters') {
      args.adapters = value(argv, index, arg).split(',').map((item) => item.trim()).filter(Boolean);
      index++;
    } else if (arg === '--cases') {
      args.cases = new Set(
        value(argv, index, arg).split(',').map((item) => item.trim()).filter(Boolean)
      );
      index++;
    } else if (arg === '--external') {
      const specification = value(argv, index, arg);
      const separator = specification.indexOf('=');
      if (separator < 1 || separator === specification.length - 1) {
        throw new Error('--external must use <id>=<executable>');
      }
      args.external.push({
        id: specification.slice(0, separator),
        executable: specification.slice(separator + 1),
      });
      index++;
    } else if (arg === '--external-manifest') {
      args.externalManifests.push(value(argv, index, arg));
      index++;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

function builtInAdapter(id: string): MemoryStackAdapter {
  switch (id) {
    case 'rembero':
      return createRemberoMemoryAdapter();
    case 'direct':
      return createDirectFactAdapter();
    case 'lexical':
      return createLexicalAdapter();
    case 'recency':
      return createRecencyAdapter();
    default:
      throw new Error(`unknown adapter: ${id}`);
  }
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const knownCases = new Set(MEMORY_STACK_CASES.map(({ id }) => id));
  if (args.cases !== null) {
    const unknown = [...args.cases].filter((id) => !knownCases.has(id));
    if (unknown.length > 0) throw new Error(`unknown case ID: ${unknown.join(', ')}`);
  }
  const cases = MEMORY_STACK_CASES.filter(({ id }) => args.cases?.has(id) ?? true);
  const caseIds = new Set(cases.map(({ id }) => id));
  const labels = MEMORY_STACK_LABELS.filter(({ caseId }) => caseIds.has(caseId));
  const adapters = args.adapters.map(builtInAdapter);
  for (const external of args.external) {
    adapters.push(
      createExternalCommandAdapter(
        {
          id: external.id,
          version: 'external',
          capabilities: {
            answerRows: true,
            rankedRetrieval: true,
            citations: true,
            rules: false,
            temporalUpdates: false,
            trustViews: false,
          },
        },
        { executable: external.executable }
      )
    );
  }
  for (const manifestPath of args.externalManifests) {
    const manifest = await loadExternalAdapterManifest(manifestPath);
    adapters.push(
      createExternalCommandAdapter(manifest.descriptor, manifest.command)
    );
  }
  const adapterIds = adapters.map((adapter) => adapter.describe().id);
  if (new Set(adapterIds).size !== adapterIds.length) {
    throw new Error('adapter IDs must be unique');
  }

  const runs = [];
  for (const adapter of adapters) {
    if (!args.json) console.error(`Running ${adapter.describe().id}...`);
    runs.push(
      await runMemoryStackBenchmark({
        suite: MEMORY_STACK_SUITE,
        cases,
        labels,
        adapter,
      })
    );
  }

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2));
  } else {
    console.log(
      '\nadapter | answer coverage | answer accuracy | retrieval recall | MRR | citation recall | stale leakage | p50 ms | p95 ms | errors'
    );
    console.log('--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');
    for (const run of runs) {
      const summary = run.summary;
      console.log(
        `${run.adapter.id} | ${percent(summary.answerCoverage)} | ${percent(summary.answerAccuracy)} | ${percent(summary.retrievalRecallAtK)} | ${percent(summary.meanReciprocalRank)} | ${percent(summary.citationRecall)} | ${percent(summary.staleLeakageRate)} | ${summary.medianWallMs.toFixed(2)} | ${summary.p95WallMs.toFixed(2)} | ${summary.operationalErrors}`
      );
    }
  }

  const rembero = runs.find((run) => run.adapter.id === 'rembero-engine');
  if (runs.some((run) => run.summary.operationalErrors > 0)) process.exitCode = 1;
  if (
    args.check &&
    (rembero === undefined ||
      rembero.summary.answerCoverage !== 1 ||
      rembero.summary.answerAccuracy !== 1 ||
      rembero.summary.answerabilityAccuracy !== 1 ||
      rembero.summary.citationRecall !== 1 ||
      rembero.summary.staleLeakageRate !== 0)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
