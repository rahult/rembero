import { performance } from 'node:perf_hooks';
import {
  evaluate,
  evaluateWithProof,
  parseProgram,
  parseQuery,
  type EvaluationMetrics,
} from '../engine/index.js';

export interface AgentDbScaleCase {
  facts: number;
  programBytes: number;
  parseMs: number;
  queryMedianMs: number;
  queryP95Ms: number;
  proofMedianMs: number;
  proofP95Ms: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  processMaxRssBytes: number;
  indexFactsProcessed: number;
  candidateFactsVisited: number;
  indexedRelationLookups: number;
  rowsAndProofsCorrect: boolean;
}

export interface AgentDbScaleSweep {
  factCounts: number[];
  repetitions: number;
  cases: AgentDbScaleCase[];
  maxima: {
    facts: number;
    programBytes: number;
    parseMs: number;
    queryP95Ms: number;
    proofP95Ms: number;
    processMaxRssBytes: number;
  };
}

const DEFAULT_FACT_COUNTS = [1_000, 10_000, 50_000, 100_000] as const;

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function metrics(): EvaluationMetrics {
  return {
    relationLookups: 0,
    indexedRelationLookups: 0,
    indexFactsProcessed: 0,
    candidateFactsVisited: 0,
  };
}

function corpus(facts: number): string {
  const clauses = new Array<string>(facts + 2);
  for (let index = 0; index < facts; index++) {
    clauses[index] = `related(person_${index}, topic_${index % 997}).`;
  }
  clauses[facts] = `selected(person_${facts - 1}).`;
  clauses[facts + 1] = 'relevant(Person, Topic) :- selected(Person), related(Person, Topic).';
  return clauses.join('\n');
}

function validateFactCounts(values: readonly number[]): number[] {
  const result = [...new Set(values)].sort((left, right) => left - right);
  if (
    result.length === 0 ||
    result.some((value) => !Number.isInteger(value) || value < 1 || value > 1_000_000)
  ) {
    throw new Error('fact counts must contain integers between 1 and 1,000,000');
  }
  return result;
}

export function runAgentDbScaleSweep(options: {
  factCounts?: readonly number[];
  repetitions?: number;
} = {}): AgentDbScaleSweep {
  const factCounts = validateFactCounts(options.factCounts ?? DEFAULT_FACT_COUNTS);
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 25) {
    throw new Error('scale repetitions must be an integer between 1 and 25');
  }
  const cases: AgentDbScaleCase[] = [];
  for (const facts of factCounts) {
    const rssBeforeBytes = process.memoryUsage().rss;
    let program = corpus(facts);
    const programBytes = Buffer.byteLength(program, 'utf8');
    const parseStarted = performance.now();
    const clauses = parseProgram(program);
    const parseMs = performance.now() - parseStarted;
    program = '';
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    const query = parseQuery('relevant(Person, Topic)');
    const limits = {
      maxFacts: facts + 10,
      maxRows: 2,
      maxIterations: 8,
      relationIndex: 'auto' as const,
    };
    const querySamples: number[] = [];
    const proofSamples: number[] = [];
    let finalMetrics = metrics();
    let rowsAndProofsCorrect = true;
    const expectedPerson = `person_${facts - 1}`;
    const expectedTopic = `topic_${(facts - 1) % 997}`;
    for (let index = 0; index < repetitions; index++) {
      const queryMetrics = metrics();
      const queryStarted = performance.now();
      const rows = evaluate(clauses, query, { ...limits, metrics: queryMetrics });
      querySamples.push(performance.now() - queryStarted);
      finalMetrics = queryMetrics;
      rowsAndProofsCorrect &&=
        rows.length === 1 &&
        rows[0]?.Person?.type === 'atom' &&
        rows[0].Person.value === expectedPerson &&
        rows[0]?.Topic?.type === 'atom' &&
        rows[0].Topic.value === expectedTopic;

      const proofStarted = performance.now();
      const explained = evaluateWithProof(clauses, query, limits);
      proofSamples.push(performance.now() - proofStarted);
      const serialized = JSON.stringify(explained);
      rowsAndProofsCorrect &&=
        explained.length === 1 &&
        serialized.includes(expectedPerson) &&
        serialized.includes(expectedTopic) &&
        serialized.includes('selected') &&
        serialized.includes('related');
    }
    cases.push({
      facts,
      programBytes,
      parseMs,
      queryMedianMs: percentile(querySamples, 0.5),
      queryP95Ms: percentile(querySamples, 0.95),
      proofMedianMs: percentile(proofSamples, 0.5),
      proofP95Ms: percentile(proofSamples, 0.95),
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
      processMaxRssBytes: process.resourceUsage().maxRSS * 1_024,
      indexFactsProcessed: finalMetrics.indexFactsProcessed,
      candidateFactsVisited: finalMetrics.candidateFactsVisited,
      indexedRelationLookups: finalMetrics.indexedRelationLookups,
      rowsAndProofsCorrect,
    });
  }
  return {
    factCounts,
    repetitions,
    cases,
    maxima: {
      facts: Math.max(...cases.map(({ facts }) => facts)),
      programBytes: Math.max(...cases.map(({ programBytes }) => programBytes)),
      parseMs: Math.max(...cases.map(({ parseMs }) => parseMs)),
      queryP95Ms: Math.max(...cases.map(({ queryP95Ms }) => queryP95Ms)),
      proofP95Ms: Math.max(...cases.map(({ proofP95Ms }) => proofP95Ms)),
      processMaxRssBytes: Math.max(
        ...cases.map(({ processMaxRssBytes }) => processMaxRssBytes)
      ),
    },
  };
}
