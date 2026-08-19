#!/usr/bin/env node
import { buildAgentDbScorecard } from './agent-db-scorecard.js';

interface Args {
  check: boolean;
  json: boolean;
  repetitions: number;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { check: false, json: false, repetitions: 10 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') result.check = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--repetitions') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value)) throw new Error('--repetitions needs an integer');
      result.repetitions = value;
      index++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run bench:agent-db -- [options]

Options:
  --check               Exit non-zero when a scorecard gate fails
  --json                Print the complete machine-readable scorecard
  --repetitions <count> Repeat the deterministic engine suite (default: 10)`);
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
  const scorecard = await buildAgentDbScorecard({ repetitions: args.repetitions });
  if (args.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(`agent database scorecard: ${scorecard.gates.passed ? 'PASS' : 'FAIL'}`);
    console.log(`evidence digest: ${scorecard.evidenceDigest}`);
    console.log('');
    console.log('dimension | metric | result');
    console.log('--- | --- | ---:');
    console.log(`accuracy | exact answers | ${percent(scorecard.accuracy.answerAccuracy)}`);
    console.log(
      `accuracy | answerability | ${percent(scorecard.accuracy.answerabilityAccuracy)}`
    );
    console.log(`accuracy | citation recall | ${percent(scorecard.accuracy.citationRecall)}`);
    console.log(`accuracy | stale leakage | ${percent(scorecard.accuracy.staleLeakageRate)}`);
    console.log(`speed | engine p50 | ${scorecard.speed.engineMedianMs.toFixed(2)} ms`);
    console.log(`speed | engine p95 | ${scorecard.speed.engineP95Ms.toFixed(2)} ms`);
    console.log(`speed | MCP startup | ${scorecard.speed.mcpStartupMs.toFixed(2)} ms`);
    console.log(
      `speed | MCP explain round trip | ${scorecard.speed.mcpExplainRoundTripMs.toFixed(2)} ms`
    );
    console.log(`scale | maximum facts | ${scorecard.speed.scale.maxima.facts}`);
    console.log(
      `scale | maximum query p95 | ${scorecard.speed.scale.maxima.queryP95Ms.toFixed(2)} ms`
    );
    console.log(
      `scale | maximum proof p95 | ${scorecard.speed.scale.maxima.proofP95Ms.toFixed(2)} ms`
    );
    console.log(`cost | model calls / structured query | 0`);
    console.log(`cost | embedding calls / structured query | 0`);
    console.log(`cost | required API keys / structured query | 0`);
    console.log(`ease | setup commands | ${scorecard.ease.setupCommandCount}`);
    console.log(`ease | discovered MCP tools | ${scorecard.ease.discoveredTools}`);
    if (scorecard.gates.failures.length > 0) {
      console.log('');
      for (const failure of scorecard.gates.failures) console.log(`FAIL: ${failure}`);
    }
  }
  if (args.check && !scorecard.gates.passed) process.exitCode = 1;
}

await main();
