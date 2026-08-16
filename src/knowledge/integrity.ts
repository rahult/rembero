import { createHash } from 'node:crypto';
import {
  type Clause,
  type Goal,
  type ScalarExpression,
  type Term,
  type EvaluateOptions,
  EngineLimitError,
  EngineSafetyError,
  canonicalKey,
  isArithmeticExpression,
  isComparison,
  isIntegrityConstraint,
  isNegation,
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
import {
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityIdentityMode,
  type EntityRewrite,
} from './identity.js';

export const DEFAULT_MAX_INTEGRITY_VIOLATIONS = 1_000;
export const MAX_INTEGRITY_VIOLATIONS = 10_000;
export const MAX_INTEGRITY_CONSTRAINTS = 256;

export type IntegrityStatus = 'unconstrained' | 'consistent' | 'violations';

export interface IntegrityCheckOptions
  extends Omit<EvaluateOptions, 'maxRows' | 'maxAggregateRows' | 'maxAggregateProofRows'> {
  /** Maximum complete violation rows returned across every constraint. */
  maxViolations?: number;
  /** Opt-in deterministic projection through explicit entity-position declarations. */
  entityIdentity?: EntityIdentityMode;
}

export interface IntegrityConstraintCheck {
  /** Stable across alpha-equivalent variable renaming. */
  id: string;
  clause: string;
  query: string;
  /** Variables in alpha-stable first-appearance order for violation identity. */
  bindingOrder: string[];
  /** Every active declaration source, in requested namespace order. */
  sources?: MemorySource[];
  projectedFrom?: string;
  identityRewrites?: EntityRewrite[];
  rows: ExplainedKnowledgeRow[];
  rules: ExplanationRule[];
  graph: ExplanationGraph;
}

function constraintBindingOrder(goals: Goal[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visitTerm = (term: Term): void => {
    if (term.type === 'var' && !seen.has(term.name)) {
      seen.add(term.name);
      ordered.push(term.name);
    }
  };
  const visitExpression = (expression: ScalarExpression): void => {
    if (!isArithmeticExpression(expression)) {
      visitTerm(expression);
    } else if (expression.kind === 'unary') {
      visitExpression(expression.operand);
    } else {
      visitExpression(expression.left);
      visitExpression(expression.right);
    }
  };
  for (const goal of goals) {
    if (isComparison(goal)) {
      visitExpression(goal.left);
      visitExpression(goal.right);
    } else {
      const literal = isNegation(goal) ? goal.not : goal;
      for (const term of literal.args) visitTerm(term);
    }
  }
  return ordered;
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
  const {
    maxViolations: requestedMaxViolations,
    entityIdentity,
    ...proofOptions
  } = options;
  const maxViolations = resolveMaxViolations(requestedMaxViolations);
  const view = entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex)
    : literalKnowledge(clauses, sourceIndex);
  const constraints: Array<{ clause: Clause; key: string }> = [];
  const seen = new Set<string>();

  for (const clause of view.clauses) {
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
    const explanation = explainKnowledge(clauses, query, sourceIndex, {
      ...proofOptions,
      maxRows: remaining + 1,
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
    });
    if (explanation.rows.length > remaining) {
      throw new EngineLimitError(
        `integrity check exceeded maxViolations ${maxViolations}`
      );
    }
    violationCount += explanation.rows.length;
    const sources = view.sources.get(key);
    const projection = view.projections.get(key)?.[0];
    checks.push({
      id: constraintId(key),
      clause: serializeClause(clause),
      query,
      bindingOrder: constraintBindingOrder(clause.body),
      ...(sources === undefined || sources.length === 0 ? {} : { sources }),
      ...(projection ?? {}),
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
