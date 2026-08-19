#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  DEFAULT_KNOWLEDGE_SEARCH_SOURCE_CHARS,
  MAX_KNOWLEDGE_SEARCH_SOURCE_CHARS,
} from '../knowledge/search.js';
import {
  downloadLongMemEvalS,
  loadLongMemEvalS,
  scoreLongMemEvalInstances,
} from './longmemeval.js';

interface Args {
  data: string;
  download: boolean;
  downloadOnly: boolean;
  json: boolean;
  limit: number | undefined;
  minimumScore: number;
  sourceCharacters: number;
  topK: number;
}

function parseArgs(argv: string[]): Args {
  const result: Args = {
    data: resolve('.cache/longmemeval/longmemeval_s_cleaned.json'),
    download: false,
    downloadOnly: false,
    json: false,
    limit: undefined,
    minimumScore: 1,
    sourceCharacters: DEFAULT_KNOWLEDGE_SEARCH_SOURCE_CHARS,
    topK: 5,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--data') {
      if (value === undefined) throw new Error('--data needs a path');
      result.data = resolve(value);
      index++;
    } else if (arg === '--download') result.download = true;
    else if (arg === '--download-only') {
      result.download = true;
      result.downloadOnly = true;
    } else if (arg === '--json') result.json = true;
    else if (arg === '--limit') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        throw new Error('--limit needs an integer between 1 and 500');
      }
      result.limit = parsed;
      index++;
    } else if (arg === '--top-k') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error('--top-k needs an integer between 1 and 100');
      }
      result.topK = parsed;
      index++;
    } else if (arg === '--source-chars') {
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_KNOWLEDGE_SEARCH_SOURCE_CHARS
      ) {
        throw new Error(
          `--source-chars needs an integer between 1 and ${MAX_KNOWLEDGE_SEARCH_SOURCE_CHARS}`
        );
      }
      result.sourceCharacters = parsed;
      index++;
    } else if (arg === '--minimum-score') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
        throw new Error('--minimum-score needs an integer between 1 and 10000');
      }
      result.minimumScore = parsed;
      index++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run bench:longmemeval -- [options]

Options:
  --download          Download and verify the pinned cleaned dataset first
  --download-only     Download and verify without running retrieval
  --data <path>       Dataset path (default: .cache/longmemeval/...)
  --limit <count>     Run the first 1-500 questions
  --top-k <count>     Retrieved sessions per question (default: 5)
  --source-chars <n>  Source characters indexed per session (default: 16384)
  --minimum-score <n> Minimum lexical evidence score (default: 1)
  --json              Print every question result`);
      process.exit(0);
    } else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.download) {
    const digest = await downloadLongMemEvalS(args.data);
    console.error(`Verified LongMemEval-S ${digest}`);
  }
  if (args.downloadOnly) return;
  const loaded = await loadLongMemEvalS(args.data);
  const instances = args.limit === undefined
    ? loaded.instances
    : loaded.instances.slice(0, args.limit);
  const run = scoreLongMemEvalInstances(instances, {
    topK: args.topK,
    sourceCharacterLimit: args.sourceCharacters,
    minimumScore: args.minimumScore,
    sha256: loaded.sha256,
  });
  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  console.log('LongMemEval-S Remembero source-search retrieval');
  console.log(`questions: ${run.summary.questions}`);
  console.log(`source characters/session: ${run.adapter.sourceCharacterLimit}`);
  console.log(`minimum score: ${run.minimumScore}`);
  console.log(`Precision@${run.topK}: ${percent(run.summary.precisionAtK)}`);
  console.log(`Recall@${run.topK}: ${percent(run.summary.recallAtK)}`);
  console.log(`MRR: ${percent(run.summary.meanReciprocalRank)}`);
  console.log(`strict evidence coverage: ${percent(run.summary.strictEvidenceCoverageRate)}`);
  console.log(`abstention empty rate: ${percent(run.summary.abstentionEmptyRate)}`);
  console.log(`latency p50/p95: ${run.summary.medianWallMs.toFixed(2)} / ${run.summary.p95WallMs.toFixed(2)} ms`);
}

await main();
