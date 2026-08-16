import type { Clause, EvaluateOptions } from '../engine/index.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from './integrity.js';
import type { MemorySource } from '../store/store.js';
import type { EntityIdentityMode } from './identity.js';
import type { ExplanationGraphSelector } from './graph-navigation.js';

export type IntegrityEnforcementMode = 'strict' | 'no_new_violations';

export interface IntegrityEnforcementOptions
  extends Omit<EvaluateOptions, 'maxRows' | 'maxAggregateRows' | 'maxAggregateProofRows'> {
  mode: IntegrityEnforcementMode;
  /** Knowledge view governed by the write. The target namespace must be included. */
  namespaces?: string[] | '*';
  /** Maximum complete violation rows considered before failing closed. */
  maxViolations?: number;
  /** Opt-in identity-aware candidate projection through declared entity positions. */
  entityIdentity?: EntityIdentityMode;
  /** Optional deterministic selection for rejection-evidence graphs. */
  graphSelector?: ExplanationGraphSelector;
}

export interface IntegrityViolationRef {
  constraintId: string;
  bindings: Record<string, string>;
}

function violationIdentity(
  constraintId: string,
  bindings: Record<string, string>,
  bindingOrder: string[]
): string {
  // Names may change under an alpha-equivalent policy edit. First-appearance
  // positions do not, so compare the values in that stable structural order.
  return JSON.stringify([
    constraintId,
    bindingOrder.map((name) => bindings[name]),
  ]);
}

function violations(result: IntegrityCheckResult): Array<{
  identity: string;
  reference: IntegrityViolationRef;
}> {
  return result.checks.flatMap((check) =>
    check.rows.map((row) => ({
      identity: violationIdentity(check.id, row.bindings, check.bindingOrder),
      reference: {
        constraintId: check.id,
        bindings: row.bindings,
      },
    }))
  );
}

export class IntegrityViolationError extends Error {
  readonly code = 'integrity_violation';

  constructor(
    readonly mode: IntegrityEnforcementMode,
    readonly baselineViolationCount: number,
    readonly result: IntegrityCheckResult,
    readonly blockingViolations: IntegrityViolationRef[],
    readonly introducedViolations: IntegrityViolationRef[]
  ) {
    super(
      mode === 'strict'
        ? `integrity enforcement rejected ${result.violationCount} violation(s)`
        : `integrity enforcement rejected ${blockingViolations.length} new violation(s)`
    );
    this.name = 'IntegrityViolationError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      mode: this.mode,
      baselineViolationCount: this.baselineViolationCount,
      blockingViolationCount: this.blockingViolations.length,
      blockingViolations: this.blockingViolations,
      introducedViolationCount: this.introducedViolations.length,
      introducedViolations: this.introducedViolations,
      candidate: this.result,
    };
  }
}

/**
 * Reject a candidate knowledge view according to an explicit enforcement mode.
 * Both snapshots must be taken while the caller owns the mutation lock.
 */
export function enforceIntegrityCandidate(
  baselineClauses: Clause[],
  candidateClauses: Clause[],
  baselineSources: Map<string, MemorySource[]>,
  candidateSources: Map<string, MemorySource[]>,
  options: IntegrityEnforcementOptions
): void {
  const { mode, namespaces: _namespaces, ...checkOptions } = options;
  const candidate = checkIntegrity(candidateClauses, candidateSources, checkOptions);
  if (candidate.status !== 'violations') return;

  const candidateViolations = violations(candidate);
  const baseline = checkIntegrity(baselineClauses, baselineSources, checkOptions);
  const baselineKeys = new Set(violations(baseline).map(({ identity }) => identity));
  const introduced = candidateViolations.filter(
    ({ identity }) => !baselineKeys.has(identity)
  );
  if (mode === 'strict') {
    throw new IntegrityViolationError(
      mode,
      baseline.violationCount,
      candidate,
      candidateViolations.map(({ reference }) => reference),
      introduced.map(({ reference }) => reference)
    );
  }

  if (introduced.length > 0) {
    throw new IntegrityViolationError(
      mode,
      baseline.violationCount,
      candidate,
      introduced.map(({ reference }) => reference),
      introduced.map(({ reference }) => reference)
    );
  }
}
