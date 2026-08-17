import type { Clause, EvaluationMetrics } from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  explainKnowledge,
  type ExplainKnowledgeOptions,
  type ExplainKnowledgeResult,
} from './graph.js';

export interface ProfileKnowledgeOptions
  extends Omit<ExplainKnowledgeOptions, 'metrics' | 'relationIndex'> {
  compareFullScan?: boolean;
}

export interface KnowledgeWorkReduction {
  candidateFactsAvoided: number;
  candidateVisitRatio: number | null;
}

export interface ProfileKnowledgeResult {
  explanation: ExplainKnowledgeResult;
  indexed: EvaluationMetrics;
  fullScan?: EvaluationMetrics;
  equivalent?: true;
  workReduction?: KnowledgeWorkReduction;
}

function emptyMetrics(): EvaluationMetrics {
  return {
    relationLookups: 0,
    indexedRelationLookups: 0,
    indexFactsProcessed: 0,
    candidateFactsVisited: 0,
  };
}

function metricCopy(metrics: EvaluationMetrics): EvaluationMetrics {
  return { ...metrics };
}

function workReduction(
  indexed: EvaluationMetrics,
  scanned: EvaluationMetrics
): KnowledgeWorkReduction {
  const ratio =
    indexed.candidateFactsVisited === 0
      ? scanned.candidateFactsVisited === 0
        ? 1
        : null
      : Math.round(
          (scanned.candidateFactsVisited / indexed.candidateFactsVisited) * 10_000
        ) / 10_000;
  return {
    candidateFactsAvoided:
      scanned.candidateFactsVisited - indexed.candidateFactsVisited,
    candidateVisitRatio: ratio,
  };
}

/** Profile deterministic relation work; optional comparison reruns with indexes disabled. */
export function profileKnowledge(
  clauses: Clause[],
  query: string,
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: ProfileKnowledgeOptions = {}
): ProfileKnowledgeResult {
  const { compareFullScan = false, ...explainOptions } = options;
  if (typeof compareFullScan !== 'boolean') {
    throw new Error('compareFullScan must be a boolean');
  }
  const indexedMetrics = emptyMetrics();
  const explanation = explainKnowledge(clauses, query, sourceIndex, {
    ...explainOptions,
    relationIndex: 'auto',
    metrics: indexedMetrics,
  });
  if (!compareFullScan) {
    return { explanation, indexed: metricCopy(indexedMetrics) };
  }
  const fullScanMetrics = emptyMetrics();
  const scanned = explainKnowledge(clauses, query, sourceIndex, {
    ...explainOptions,
    relationIndex: 'off',
    metrics: fullScanMetrics,
  });
  if (JSON.stringify(scanned) !== JSON.stringify(explanation)) {
    throw new Error('indexed and full-scan explanations are not equivalent');
  }
  const indexed = metricCopy(indexedMetrics);
  const fullScan = metricCopy(fullScanMetrics);
  return {
    explanation,
    indexed,
    fullScan,
    equivalent: true,
    workReduction: workReduction(indexed, fullScan),
  };
}
