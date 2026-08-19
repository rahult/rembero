#!/usr/bin/env node
import { runAgentDbInstallBenchmark } from './agent-db-install.js';

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== '--json' && arg !== '--check');
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(', ')}`);
  const result = await runAgentDbInstallBenchmark();
  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`clean install benchmark: ${result.gates.passed ? 'PASS' : 'FAIL'}`);
    console.log(`cold npm install: ${milliseconds(result.timings.coldInstallMs)}`);
    console.log(`first write: ${milliseconds(result.timings.firstWriteMs)}`);
    console.log(`first proof query: ${milliseconds(result.timings.firstProofQueryMs)}`);
    console.log(`installed package: ${(result.package.installedBytes / 1_048_576).toFixed(2)} MiB`);
    console.log(`proof answer/sources: ${result.proof.expectedAnswer}/${result.proof.expectedSources}`);
    for (const failure of result.gates.failures) console.error(`- ${failure}`);
  }
  if (args.has('--check') && !result.gates.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
