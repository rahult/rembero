import { createHash } from 'node:crypto';
import {
  type Clause,
  type EvaluateOptions,
  EngineLimitError,
  EngineSafetyError,
  canonicalKey,
  isIntegrityConstraint,
  serializeClause,
  serializeGoal,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  explainKnowledge,
  type ExplainedKnowledgeRow,
  type ExplanationGraph,
  type ExplanationRule,
} from './graph.js';

export const DEFAULT_MAX_INTEGRITY_VIOLATIONS = 1_000;
export const MAX_INTEGRITY_VIOLATIONS = 10_000;
export const MAX_INTEGRITY_CONSTRAINTS = 256;

export type IntegrityStatus = 'unconstrained' | 'consistent' | 'violations';

export interface IntegrityCheckOptions
  extends Omit<EvaluateOptions, 'maxRows' | 'maxAggregateRows' | 'maxAggregateProofRows'> {
  /** Maximum complete violation rows returned across every constraint. */
  maxViolations?: number;
}

export interface IntegrityConstraintCheck {
  /** Stable across alpha-equivalent variable renaming. */
  id: string;
  clause: string;
  query: string;
  /** Every active declaration source, in requested namespace order. */
  sources?: MemorySource[];
  rows: ExplainedKnowledgeRow[];
  rules: ExplanationRule[];
  graph: ExplanationGraph;
}

export interface IntegrityCheckResult {
  status: IntegrityStatus;
  constraintCount: number;
  violationCount: number;
  checks: IntegrityConstraintCheck[];
}

function resolveMaxViolations(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_INTEGRITY_VIOLATIONS;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new EngineSafetyError('maxViolations must be a positive safe integer');
  }
  if (resolved > MAX_INTEGRITY_VIOLATIONS) {
    throw new EngineSafetyError(
      `maxViolations must be at most ${MAX_INTEGRITY_VIOLATIONS}`
    );
  }
  return resolved;
}

function constraintId(key: string): string {
  return `constraint:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Inspect explicit headless constraints against one current, selected knowledge view.
 * The operation is read-only: a satisfied body is reported as a violation, while
 * ordinary query evaluation remains unaffected by the declarations.
 */
export function checkIntegrity(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: IntegrityCheckOptions = {}
): IntegrityCheckResult {
  const { maxViolations: requestedMaxViolations, ...proofOptions } = options;
  const maxViolations = resolveMaxViolations(requestedMaxViolations);
  const executableClauses = clauses.filter((clause) => !isIntegrityConstraint(clause));
  const constraints: Array<{ clause: Clause; key: string }> = [];
  const seen = new Set<string>();

  for (const clause of clauses) {
    if (!isIntegrityConstraint(clause)) continue;
    const key = canonicalKey(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push({ clause, key });
    if (constraints.length > MAX_INTEGRITY_CONSTRAINTS) {
      throw new EngineLimitError(
        `integrity check exceeded ${MAX_INTEGRITY_CONSTRAINTS} constraints`
      );
    }
  }

  if (constraints.length === 0) {
    return {
      status: 'unconstrained',
      constraintCount: 0,
      violationCount: 0,
      checks: [],
    };
  }

  const checks: IntegrityConstraintCheck[] = [];
  let violationCount = 0;
  for (const { clause, key } of constraints) {
    const query = clause.body.map(serializeGoal).join(', ');
    const remaining = maxViolations - violationCount;
    const explanation = explainKnowledge(executableClauses, query, sourceIndex, {
      ...proofOptions,
      maxRows: remaining + 1,
    });
    if (explanation.rows.length > remaining) {
      throw new EngineLimitError(
        `integrity check exceeded maxViolations ${maxViolations}`
      );
    }
    violationCount += explanation.rows.length;
    const sources = sourceIndex.get(key);
    checks.push({
      id: constraintId(key),
      clause: serializeClause(clause),
      query,
      ...(sources === undefined || sources.length === 0 ? {} : { sources }),
      rows: explanation.rows,
      rules: explanation.rules,
      graph: explanation.graph,
    });
  }

  return {
    status: violationCount === 0 ? 'consistent' : 'violations',
    constraintCount: constraints.length,
    violationCount,
    checks,
  };
}
