import { performance } from 'node:perf_hooks';
import {
  evaluate,
  evaluateWithProof,
  parseProgram,
  parseQuery,
  type EvaluationMetrics,
} from '../engine/index.js';

interface Scenario {
  facts: number;
  selected: number;
}

interface ModeResult {
  medianMs: number;
  indexFactsProcessed: number;
  candidateFactsVisited: number;
  indexedRelationLookups: number;
}

interface EvaluationLimits {
  maxFacts: number;
  maxRows: number;
  maxIterations?: number;
}

const scenarios: Scenario[] = [
  { facts: 10_000, selected: 100 },
  { facts: 50_000, selected: 250 },
];
const repeats = 5;

function createMetrics(): EvaluationMetrics {
  return {
    relationLookups: 0,
    indexedRelationLookups: 0,
    indexFactsProcessed: 0,
    candidateFactsVisited: 0,
  };
}

function corpus({ facts, selected }: Scenario): string {
  const clauses: string[] = [];
  for (let index = 0; index < facts; index++) {
    clauses.push(`related(person_${index}, topic_${index % 97}).`);
  }
  for (let index = facts - selected; index < facts; index++) {
    clauses.push(`selected(person_${index}).`);
  }
  clauses.push('relevant(X, Y) :- selected(X), related(X, Y).');
  return clauses.join('\n');
}

function recursiveCorpus(facts: number): string {
  const clauses = ['seed(node_0).'];
  for (let index = 0; index < facts; index++) {
    clauses.push(`edge(node_${index}, node_${index + 1}).`);
  }
  clauses.push(
    'reachable(Y) :- seed(X), edge(X, Y).',
    'reachable(Y) :- reachable(X), edge(X, Y).'
  );
  return clauses.join('\n');
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function runMode(
  clauses: ReturnType<typeof parseProgram>,
  query: ReturnType<typeof parseQuery>,
  limits: EvaluationLimits,
  relationIndex: 'auto' | 'off'
): { serializedRows: string; result: ModeResult } {
  const options = {
    ...limits,
    relationIndex,
  } as const;

  evaluate(clauses, query, options);
  const samples: number[] = [];
  let serializedRows = '';
  let finalMetrics = createMetrics();
  for (let iteration = 0; iteration < repeats; iteration++) {
    const metrics = createMetrics();
    const started = performance.now();
    const rows = evaluate(clauses, query, { ...options, metrics });
    samples.push(performance.now() - started);
    serializedRows = JSON.stringify(rows);
    finalMetrics = metrics;
  }

  return {
    serializedRows,
    result: {
      medianMs: Number(median(samples).toFixed(2)),
      indexFactsProcessed: finalMetrics.indexFactsProcessed,
      candidateFactsVisited: finalMetrics.candidateFactsVisited,
      indexedRelationLookups: finalMetrics.indexedRelationLookups,
    },
  };
}

for (const scenario of scenarios) {
  const clauses = parseProgram(corpus(scenario));
  const query = parseQuery('relevant(X, Y)');
  const limits = {
    maxFacts: scenario.facts + scenario.selected * 2 + 10,
    maxRows: scenario.selected + 1,
  };
  const scanned = runMode(clauses, query, limits, 'off');
  const indexed = runMode(clauses, query, limits, 'auto');
  if (indexed.serializedRows !== scanned.serializedRows) {
    throw new Error('relation index changed deterministic row output');
  }

  const scannedProofs = JSON.stringify(
    evaluateWithProof(clauses, query, { ...limits, relationIndex: 'off' })
  );
  const indexedProofs = JSON.stringify(
    evaluateWithProof(clauses, query, { ...limits, relationIndex: 'auto' })
  );
  if (indexedProofs !== scannedProofs) {
    throw new Error('relation index changed deterministic proof output');
  }

  const speedup = scanned.result.medianMs / indexed.result.medianMs;
  const workReduction =
    scanned.result.candidateFactsVisited /
    (indexed.result.indexFactsProcessed + indexed.result.candidateFactsVisited);
  if (speedup < 2) {
    throw new Error(
      `indexed median must be at least 2x faster; observed ${speedup.toFixed(2)}x`
    );
  }
  if (workReduction < 100) {
    throw new Error(
      `indexed relation work must fall by at least 100x; observed ${workReduction.toFixed(2)}x`
    );
  }

  console.log(
    JSON.stringify({
      ...scenario,
      rows: scenario.selected,
      scanned: scanned.result,
      indexed: indexed.result,
      speedup: Number(speedup.toFixed(2)),
      relationWorkReduction: Number(workReduction.toFixed(2)),
      rowsAndProofsIdentical: true,
    })
  );
}

const recursiveFacts = 2_000;
const recursiveClauses = parseProgram(recursiveCorpus(recursiveFacts));
const recursiveQuery = parseQuery('reachable(X)');
const recursiveLimits = {
  maxFacts: recursiveFacts * 2 + 10,
  maxIterations: recursiveFacts * 3 + 10,
  maxRows: recursiveFacts + 1,
};
const recursiveScanned = runMode(
  recursiveClauses,
  recursiveQuery,
  recursiveLimits,
  'off'
);
const recursiveIndexed = runMode(
  recursiveClauses,
  recursiveQuery,
  recursiveLimits,
  'auto'
);
if (recursiveIndexed.serializedRows !== recursiveScanned.serializedRows) {
  throw new Error('relation index changed recursive row output');
}
const recursiveProofLimits = { ...recursiveLimits, maxRows: 64 };
const recursiveScannedProofs = JSON.stringify(
  evaluateWithProof(recursiveClauses, recursiveQuery, {
    ...recursiveProofLimits,
    relationIndex: 'off',
  })
);
const recursiveIndexedProofs = JSON.stringify(
  evaluateWithProof(recursiveClauses, recursiveQuery, {
    ...recursiveProofLimits,
    relationIndex: 'auto',
  })
);
if (recursiveIndexedProofs !== recursiveScannedProofs) {
  throw new Error('relation index changed recursive proof output');
}
const recursiveSpeedup =
  recursiveScanned.result.medianMs / recursiveIndexed.result.medianMs;
const recursiveWorkReduction =
  recursiveScanned.result.candidateFactsVisited /
  (recursiveIndexed.result.indexFactsProcessed +
    recursiveIndexed.result.candidateFactsVisited);
if (recursiveSpeedup < 2 || recursiveWorkReduction < 100) {
  throw new Error(
    `recursive index acceptance failed: ${recursiveSpeedup.toFixed(2)}x speedup, ${recursiveWorkReduction.toFixed(2)}x work reduction`
  );
}
console.log(
  JSON.stringify({
    scenario: 'recursive-growth',
    facts: recursiveFacts,
    rows: recursiveFacts,
    scanned: recursiveScanned.result,
    indexed: recursiveIndexed.result,
    speedup: Number(recursiveSpeedup.toFixed(2)),
    relationWorkReduction: Number(recursiveWorkReduction.toFixed(2)),
    rowsAndProofsIdentical: true,
  })
);
