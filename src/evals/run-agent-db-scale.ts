#!/usr/bin/env node
import { runAgentDbScaleSweep } from './agent-db-scale.js';

interface Args {
  check: boolean;
  checkMillion: boolean;
  json: boolean;
  facts: number[] | undefined;
  repetitions: number;
}

function parseArgs(argv: string[]): Args {
  const result: Args = {
    check: false,
    checkMillion: false,
    json: false,
    facts: undefined,
    repetitions: 3,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') result.check = true;
    else if (arg === '--check-million') result.checkMillion = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--facts') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--facts needs a comma-separated list');
      result.facts = value.split(',').map(Number);
      index++;
    } else if (arg === '--repetitions') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value)) throw new Error('--repetitions needs an integer');
      result.repetitions = value;
      index++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run bench:agent-db:scale -- [options]

Options:
  --check               Gate the default 100,000-fact sweep
  --check-million       Gate one repeated 1,000,000-fact run with RSS budget
  --json                Print machine-readable results
  --facts <list>        Fact counts, up to 1,000,000
  --repetitions <count> Query and proof repetitions (default: 3)`);
      process.exit(0);
    } else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.check && args.checkMillion) {
    throw new Error('--check and --check-million are mutually exclusive');
  }
  const sweep = runAgentDbScaleSweep({
    ...(args.facts === undefined ? {} : { factCounts: args.facts }),
    repetitions: args.repetitions,
  });
  if (args.json) console.log(JSON.stringify(sweep, null, 2));
  else {
    console.log('facts | program MiB | parse ms | query p50 | query p95 | proof p50 | proof p95 | max RSS MiB | indexed | correct');
    console.log('---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---:');
    for (const result of sweep.cases) {
      console.log(
        `${result.facts} | ${(result.programBytes / 1024 / 1024).toFixed(2)} | ${result.parseMs.toFixed(2)} | ${result.queryMedianMs.toFixed(2)} | ${result.queryP95Ms.toFixed(2)} | ${result.proofMedianMs.toFixed(2)} | ${result.proofP95Ms.toFixed(2)} | ${(result.processMaxRssBytes / 1024 / 1024).toFixed(2)} | ${result.indexedRelationLookups} | ${result.rowsAndProofsCorrect ? 'yes' : 'no'}`
      );
    }
  }
  if (args.check) {
    const failures = sweep.cases.flatMap((result) => [
      ...(result.rowsAndProofsCorrect ? [] : [`${result.facts}: row/proof mismatch`]),
      ...(result.indexedRelationLookups > 0 ? [] : [`${result.facts}: relation index unused`]),
      ...(result.candidateFactsVisited <= 10
        ? []
        : [`${result.facts}: visited ${result.candidateFactsVisited} candidates`]),
    ]);
    if (sweep.maxima.parseMs > 2_000) failures.push('maximum parse time exceeds 2000ms');
    if (sweep.maxima.queryP95Ms > 250) failures.push('maximum query p95 exceeds 250ms');
    if (sweep.maxima.proofP95Ms > 500) failures.push('maximum proof p95 exceeds 500ms');
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      process.exitCode = 1;
    }
  }
  if (args.checkMillion) {
    const failures: string[] = [];
    if (sweep.factCounts.length !== 1 || sweep.factCounts[0] !== 1_000_000) {
      failures.push('million gate requires exactly --facts 1000000');
    }
    if (sweep.repetitions < 3) failures.push('million gate requires at least 3 repetitions');
    for (const result of sweep.cases) {
      if (!result.rowsAndProofsCorrect) failures.push('million gate row/proof mismatch');
      if (result.indexedRelationLookups < 1) failures.push('million gate relation index unused');
      if (result.candidateFactsVisited > 10) {
        failures.push(`million gate visited ${result.candidateFactsVisited} candidates`);
      }
    }
    if (sweep.maxima.parseMs > 2_000) failures.push('million parse time exceeds 2000ms');
    if (sweep.maxima.queryP95Ms > 2_000) failures.push('million query p95 exceeds 2000ms');
    if (sweep.maxima.proofP95Ms > 2_500) failures.push('million proof p95 exceeds 2500ms');
    if (sweep.maxima.processMaxRssBytes > 2.5 * 1024 * 1024 * 1024) {
      failures.push('million process max RSS exceeds 2560 MiB');
    }
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      process.exitCode = 1;
    }
  }
}

await main();
