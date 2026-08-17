import type { Clause, EvaluateOptions } from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  runKnowledgeChecks,
  type KnowledgeCheckSuite,
  type KnowledgeCheckSuiteResult,
  type RunKnowledgeChecksOptions,
} from './checks.js';
import type { EntityIdentityMode } from './identity.js';
import type { TrustViewMode } from './trust.js';

export type KnowledgeCheckEnforcementMode = 'strict' | 'no_regressions';

export interface KnowledgeCheckEnforcementOptions
  extends Pick<
      EvaluateOptions,
      | 'maxFacts'
      | 'maxIterations'
      | 'maxRows'
      | 'maxAggregateRows'
      | 'maxAggregateProofRows'
      | 'maxProofDepth'
      | 'maxProofNodes'
      | 'maxProofsPerRow'
      | 'maxProofEnumerationSteps'
      | 'relationIndex'
    > {
  mode: KnowledgeCheckEnforcementMode;
  suite: KnowledgeCheckSuite | string;
  namespaces?: string[] | '*';
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
}

export interface KnowledgeCheckEnforcementDelta {
  baseline: KnowledgeCheckSuiteResult;
  candidate: KnowledgeCheckSuiteResult;
  regressed: string[];
  fixed: string[];
  coveragePercentBefore: number;
  coveragePercentAfter: number;
  coveragePercentDelta: number;
  coverageRegressed: boolean;
}

function delta(
  baseline: KnowledgeCheckSuiteResult,
  candidate: KnowledgeCheckSuiteResult
): KnowledgeCheckEnforcementDelta {
  const before = new Map(
    baseline.checks.map((check) => [check.name, check.status])
  );
  const after = new Map(
    candidate.checks.map((check) => [check.name, check.status])
  );
  return {
    baseline,
    candidate,
    regressed: [...before]
      .filter(([name, status]) => status === 'passed' && after.get(name) === 'failed')
      .map(([name]) => name),
    fixed: [...before]
      .filter(([name, status]) => status === 'failed' && after.get(name) === 'passed')
      .map(([name]) => name),
    coveragePercentBefore: baseline.coverage.percent,
    coveragePercentAfter: candidate.coverage.percent,
    coveragePercentDelta: candidate.coverage.percent - baseline.coverage.percent,
    coverageRegressed:
      candidate.coverage.percent < baseline.coverage.percent ||
      (baseline.coveragePassed && !candidate.coveragePassed),
  };
}

export class KnowledgeCheckEnforcementError extends Error {
  readonly code = 'knowledge_check_enforcement';

  constructor(
    readonly mode: KnowledgeCheckEnforcementMode,
    readonly result: KnowledgeCheckEnforcementDelta
  ) {
    super(
      mode === 'strict'
        ? 'knowledge check enforcement rejected a failing candidate'
        : `knowledge check enforcement rejected ${result.regressed.length} regressed check(s)${result.coverageRegressed ? ' and coverage regression' : ''}`
    );
    this.name = 'KnowledgeCheckEnforcementError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      mode: this.mode,
      regressed: this.result.regressed,
      fixed: this.result.fixed,
      coverageRegressed: this.result.coverageRegressed,
      coveragePercentBefore: this.result.coveragePercentBefore,
      coveragePercentAfter: this.result.coveragePercentAfter,
      baseline: this.result.baseline,
      candidate: this.result.candidate,
    };
  }
}

/** Reject a write candidate using one portable suite over complete immutable views. */
export function enforceKnowledgeCheckCandidate(
  baselineClauses: Clause[],
  candidateClauses: Clause[],
  baselineSources: Map<string, MemorySource[]>,
  candidateSources: Map<string, MemorySource[]>,
  options: KnowledgeCheckEnforcementOptions
): KnowledgeCheckEnforcementDelta {
  const {
    mode,
    suite,
    namespaces: _namespaces,
    entityIdentity,
    trustMode,
    ...evaluateOptions
  } = options;
  if (mode !== 'strict' && mode !== 'no_regressions') {
    throw new Error("knowledge check enforcement mode must be 'strict' or 'no_regressions'");
  }
  const runOptions: RunKnowledgeChecksOptions = {
    ...evaluateOptions,
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === undefined ? {} : { trustMode }),
  };
  const result = delta(
    runKnowledgeChecks(baselineClauses, baselineSources, suite, runOptions),
    runKnowledgeChecks(candidateClauses, candidateSources, suite, runOptions)
  );
  const blocked = mode === 'strict'
    ? result.candidate.status !== 'passed'
    : result.regressed.length > 0 || result.coverageRegressed;
  if (blocked) throw new KnowledgeCheckEnforcementError(mode, result);
  return result;
}
