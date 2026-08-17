import {
  type Clause,
  isIntegrityConstraint,
  parseProgram,
  serializeClause,
} from '../engine/index.js';
import { assertBoundedInput } from '../safety.js';
import {
  type MemoryStore,
  type RuleChangeMutationResult,
  MAX_RULE_CHANGE_RULES,
} from '../store/store.js';
import {
  computeRuleChangeProposalDigest,
  type RuleChangeProposal,
} from './counterfactual.js';
import {
  auditKnowledgeRules,
  type RuleAuditResult,
} from './rule-audit.js';
import {
  parseKnowledgeCheckSuite,
  runKnowledgeChecks,
  type KnowledgeCheckSuiteResult,
} from './checks.js';
import type { EntityIdentityMode } from './identity.js';
import type { TrustViewMode } from './trust.js';
import type { KnowledgeCheckEnforcementOptions } from './check-enforcement.js';

export const RULE_CHANGE_PROPOSAL_VERSION = 1;
export const MAX_RULE_CHANGE_PROPOSAL_BYTES = 2 * 1024 * 1024;

export interface ApplyRuleChangeProposalOptions {
  opId: string;
  at?: Date;
  maxViolations?: number;
  maxFacts?: number;
  maxIterations?: number;
  knowledgeCheckEnforcement?: KnowledgeCheckEnforcementOptions;
}

export interface ApplyRuleChangeProposalResult extends RuleChangeMutationResult {
  audit: RuleAuditResult;
  checks?: KnowledgeCheckSuiteResult;
}

export class RuleChangeCheckError extends Error {
  readonly code = 'rule_change_checks_failed';

  constructor(readonly result: KnowledgeCheckSuiteResult) {
    super(
      `rule change proposal failed ${result.failedCount} knowledge check(s) or its coverage requirement`
    );
    this.name = 'RuleChangeCheckError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      result: this.result,
    };
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function canonicalRuleList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of canonical rule strings`);
  }
  if (value.length > MAX_RULE_CHANGE_RULES) {
    throw new Error(`${label} exceeds ${MAX_RULE_CHANGE_RULES} rules`);
  }
  const keys = new Set<string>();
  for (const [index, text] of value.entries()) {
    const clauses = parseProgram(text as string);
    if (
      clauses.length !== 1 ||
      clauses[0].body.length === 0 ||
      isIntegrityConstraint(clauses[0]) ||
      serializeClause(clauses[0]) !== text
    ) {
      throw new Error(`${label}[${index}] must be one canonical ordinary or aggregate rule`);
    }
    const structural = JSON.stringify(clauses[0]);
    if (keys.has(structural)) throw new Error(`${label} contains duplicate rules`);
    keys.add(structural);
  }
  return [...value] as string[];
}

function parsedProposal(value: unknown): RuleChangeProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('rule change proposal must be an object');
  }
  const outer = value as Record<string, unknown>;
  const candidate = 'ruleProposal' in outer ? outer.ruleProposal : outer;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('rule change proposal must be an object');
  }
  const record = candidate as Record<string, unknown>;
  const required = [
    'version',
    'proposalDigest',
    'baselineDigest',
    'namespace',
    'namespaces',
    'query',
    'assumeRules',
    'withoutRules',
  ];
  const optional = ['checkSuite', 'entityIdentity', 'trustMode', 'recordedSequence'];
  exactKeys(record, required, optional, 'rule change proposal');
  if (record.version !== RULE_CHANGE_PROPOSAL_VERSION) {
    throw new Error(`rule change proposal version must be ${RULE_CHANGE_PROPOSAL_VERSION}`);
  }
  for (const key of ['proposalDigest', 'baselineDigest'] as const) {
    if (typeof record[key] !== 'string' || !/^[a-f0-9]{64}$/.test(record[key])) {
      throw new Error(`rule change proposal ${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (typeof record.namespace !== 'string') {
    throw new Error('rule change proposal namespace must be a string');
  }
  if (
    !Array.isArray(record.namespaces) ||
    record.namespaces.length === 0 ||
    record.namespaces.length > 32 ||
    !record.namespaces.every((item) => typeof item === 'string') ||
    new Set(record.namespaces).size !== record.namespaces.length ||
    !record.namespaces.includes(record.namespace)
  ) {
    throw new Error('rule change proposal namespaces are invalid');
  }
  if (typeof record.query !== 'string') {
    throw new Error('rule change proposal query must be a string');
  }
  assertBoundedInput(record.query, 'rule change proposal query');
  const assumeRules = canonicalRuleList(record.assumeRules, 'rule change proposal assumeRules');
  const withoutRules = canonicalRuleList(record.withoutRules, 'rule change proposal withoutRules');
  if (assumeRules.length === 0 && withoutRules.length === 0) {
    throw new Error('rule change proposal contains no effective rule change');
  }
  if (record.checkSuite !== undefined) {
    if (typeof record.checkSuite !== 'string') {
      throw new Error('rule change proposal checkSuite must be a string');
    }
    parseKnowledgeCheckSuite(record.checkSuite);
  }
  if (record.entityIdentity !== undefined && record.entityIdentity !== 'canonical') {
    throw new Error("rule change proposal entityIdentity must be 'canonical'");
  }
  if (
    record.trustMode !== undefined &&
    record.trustMode !== 'include_tentative'
  ) {
    throw new Error("rule change proposal trustMode must be 'include_tentative'");
  }
  if (
    record.recordedSequence !== undefined &&
    (!Number.isSafeInteger(record.recordedSequence) ||
      (record.recordedSequence as number) < 0)
  ) {
    throw new Error('rule change proposal recordedSequence must be a non-negative integer');
  }
  const proposal = {
    ...record,
    assumeRules,
    withoutRules,
  } as unknown as RuleChangeProposal;
  const { proposalDigest, ...payload } = proposal;
  if (computeRuleChangeProposalDigest(payload) !== proposalDigest) {
    throw new Error('rule change proposal digest does not match its content');
  }
  return proposal;
}

/** Parse either a standalone proposal or a complete what-if result containing one. */
export function parseRuleChangeProposal(
  value: RuleChangeProposal | string | unknown
): RuleChangeProposal {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_RULE_CHANGE_PROPOSAL_BYTES) {
      throw new Error(
        `rule change proposal exceeds ${MAX_RULE_CHANGE_PROPOSAL_BYTES} bytes`
      );
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('rule change proposal is not valid JSON');
    }
  }
  return parsedProposal(parsed);
}

/** Apply one explicitly reviewed current-state proposal under the store mutation lock. */
export function applyRuleChangeProposal(
  store: MemoryStore,
  proposalValue: RuleChangeProposal | string | unknown,
  options: ApplyRuleChangeProposalOptions
): ApplyRuleChangeProposalResult {
  const proposal = parseRuleChangeProposal(proposalValue);
  if (proposal.recordedSequence !== undefined) {
    throw new Error('a rule proposal based on recorded history cannot be applied to current knowledge');
  }
  if (typeof options.opId !== 'string' || options.opId.length === 0) {
    throw new Error('rule change application requires an explicit operation id');
  }
  let audit: RuleAuditResult | undefined;
  let checks: KnowledgeCheckSuiteResult | undefined;
  const mutation = store.applyRuleChange(
    proposal.namespace,
    {
      namespaces: proposal.namespaces,
      expectedBaselineDigest: proposal.baselineDigest,
      proposalDigest: proposal.proposalDigest,
      add: proposal.assumeRules.join('\n'),
      remove: proposal.withoutRules.join('\n'),
      validateCandidate(candidate) {
        const auditOptions = {
          ...(options.maxFacts === undefined ? {} : { maxFacts: options.maxFacts }),
          ...(options.maxIterations === undefined
            ? {}
            : { maxIterations: options.maxIterations }),
          ...(proposal.entityIdentity === undefined
            ? {}
            : { entityIdentity: proposal.entityIdentity as EntityIdentityMode }),
          ...(proposal.trustMode === undefined
            ? {}
            : { trustMode: proposal.trustMode as TrustViewMode }),
        };
        audit = auditKnowledgeRules(candidate.clauses, new Map(), auditOptions);
        if (proposal.checkSuite !== undefined) {
          checks = runKnowledgeChecks(
            candidate.clauses,
            new Map(),
            proposal.checkSuite,
            {
              ...(proposal.entityIdentity === undefined
                ? {}
                : { entityIdentity: proposal.entityIdentity }),
              ...(proposal.trustMode === undefined
                ? {}
                : { trustMode: proposal.trustMode }),
            }
          );
          if (checks.status !== 'passed') throw new RuleChangeCheckError(checks);
        }
      },
    },
    {
      opId: options.opId,
      at: options.at,
      sourceText: `Applied reviewed rule change proposal ${proposal.proposalDigest}`,
      origin: 'manual',
      integrity: {
        mode: 'no_new_violations',
        namespaces: proposal.namespaces,
        ...(options.maxViolations === undefined
          ? {}
          : { maxViolations: options.maxViolations }),
        ...(proposal.entityIdentity === undefined
          ? {}
          : { entityIdentity: proposal.entityIdentity }),
      },
      ...(options.knowledgeCheckEnforcement === undefined
        ? {}
        : { checks: options.knowledgeCheckEnforcement }),
    }
  );
  // Reconstruct the exact committed journal position for stable first-call and replay output.
  const committed = store.recordedSnapshot(
    proposal.namespaces,
    mutation.sequence
  );
  audit = auditKnowledgeRules(committed.clauses, committed.sources, {
    ...(options.maxFacts === undefined ? {} : { maxFacts: options.maxFacts }),
    ...(options.maxIterations === undefined
      ? {}
      : { maxIterations: options.maxIterations }),
    ...(proposal.entityIdentity === undefined
      ? {}
      : { entityIdentity: proposal.entityIdentity }),
    ...(proposal.trustMode === undefined
      ? {}
      : { trustMode: proposal.trustMode }),
  });
  if (proposal.checkSuite !== undefined) {
    checks = runKnowledgeChecks(
      committed.clauses,
      committed.sources,
      proposal.checkSuite,
      {
        ...(proposal.entityIdentity === undefined
          ? {}
          : { entityIdentity: proposal.entityIdentity }),
        ...(proposal.trustMode === undefined
          ? {}
          : { trustMode: proposal.trustMode }),
      }
    );
  }
  return {
    ...mutation,
    audit,
    ...(checks === undefined ? {} : { checks }),
  };
}
