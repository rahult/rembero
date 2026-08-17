import {
  canonicalKey,
  isIntegrityConstraint,
  parseProgram,
  serializeClause,
  type Clause,
} from '../engine/index.js';
import { assertBoundedInput } from '../safety.js';
import {
  type MemoryStore,
  type MemoryChangeMutationResult,
  type MemoryChangeTemporalArchive,
  MAX_MEMORY_CHANGE_CLAUSES,
} from '../store/store.js';
import {
  computeMemoryProposalDigest,
  type MemoryChangeProposal,
} from './memory-proposal.js';
import {
  auditKnowledgeRules,
  type RuleAuditResult,
} from './rule-audit.js';
import {
  isEntityMetadataPredicate,
} from './identity.js';
import { isTrustMetadataPredicate } from './trust.js';
import {
  parseKnowledgeCheckSuite,
  runKnowledgeChecks,
  type KnowledgeCheckSuiteResult,
} from './checks.js';

export const MAX_MEMORY_PROPOSAL_BYTES = 2 * 1024 * 1024;

export interface ApplyMemoryProposalOptions {
  opId: string;
  at?: Date;
  maxViolations?: number;
  maxFacts?: number;
  maxIterations?: number;
}

export interface ApplyMemoryProposalResult extends MemoryChangeMutationResult {
  audit: RuleAuditResult;
  checks?: KnowledgeCheckSuiteResult;
}

export class MemoryChangeCheckError extends Error {
  readonly code = 'memory_change_checks_failed';

  constructor(readonly result: KnowledgeCheckSuiteResult) {
    super(
      `memory proposal failed ${result.failedCount} knowledge check(s) or its coverage requirement`
    );
    this.name = 'MemoryChangeCheckError';
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, result: this.result };
  }
}

function canonicalClauseList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of canonical clauses`);
  }
  if (value.length > MAX_MEMORY_CHANGE_CLAUSES) {
    throw new Error(`${label} exceeds ${MAX_MEMORY_CHANGE_CLAUSES} clauses`);
  }
  const keys = new Set<string>();
  for (const [index, serialized] of value.entries()) {
    const clauses = parseProgram(serialized as string);
    if (
      clauses.length !== 1 ||
      serializeClause(clauses[0]) !== serialized ||
      isIntegrityConstraint(clauses[0])
    ) {
      throw new Error(`${label}[${index}] must be one canonical non-policy clause`);
    }
    const clause = clauses[0];
    if (
      isEntityMetadataPredicate(clause.head.predicate) ||
      isTrustMetadataPredicate(clause.head.predicate)
    ) {
      throw new Error(`${label}[${index}] may not change reserved metadata`);
    }
    if (
      clause.body.length === 0 &&
      clause.head.args.some(
        (term) =>
          (term.type !== 'atom' && term.type !== 'num') ||
          (term.type === 'num' && !Number.isFinite(term.value))
      )
    ) {
      throw new Error(`${label}[${index}] fact must be finite and ground`);
    }
    const key = canonicalKey(clause);
    if (keys.has(key)) throw new Error(`${label} contains duplicate clauses`);
    keys.add(key);
  }
  return [...value] as string[];
}

function parsedProposal(value: unknown): MemoryChangeProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('memory proposal must be an object');
  }
  const outer = value as Record<string, unknown>;
  const candidate = 'proposal' in outer ? outer.proposal : outer;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('memory proposal must be an object');
  }
  const record = candidate as Record<string, unknown>;
  const required = [
    'version',
    'proposalDigest',
    'baselineDigest',
    'namespace',
    'namespaces',
    'sourceText',
    'validTimeMode',
    'addClauses',
    'removeClauses',
  ];
  const optional = ['at', 'entityIdentity', 'checkSuite'];
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error('memory proposal has unexpected or missing fields');
  }
  if (record.version !== 1) throw new Error('memory proposal version must be 1');
  for (const key of ['proposalDigest', 'baselineDigest'] as const) {
    if (typeof record[key] !== 'string' || !/^[a-f0-9]{64}$/.test(record[key])) {
      throw new Error(`memory proposal ${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (typeof record.namespace !== 'string') {
    throw new Error('memory proposal namespace must be a string');
  }
  if (
    !Array.isArray(record.namespaces) ||
    record.namespaces.length === 0 ||
    record.namespaces.length > 32 ||
    !record.namespaces.every((item) => typeof item === 'string') ||
    new Set(record.namespaces).size !== record.namespaces.length ||
    !record.namespaces.includes(record.namespace)
  ) {
    throw new Error('memory proposal namespaces are invalid');
  }
  if (typeof record.sourceText !== 'string') {
    throw new Error('memory proposal sourceText must be a string');
  }
  assertBoundedInput(record.sourceText, 'memory proposal source text');
  if (record.validTimeMode !== 'delete' && record.validTimeMode !== 'archive_until') {
    throw new Error("memory proposal validTimeMode must be 'delete' or 'archive_until'");
  }
  if (
    (record.validTimeMode === 'archive_until' && typeof record.at !== 'string') ||
    (record.validTimeMode === 'delete' && record.at !== undefined)
  ) {
    throw new Error('memory proposal timestamp does not match its valid-time mode');
  }
  if (typeof record.at === 'string') {
    const at = new Date(record.at);
    if (Number.isNaN(at.getTime()) || at.toISOString() !== record.at) {
      throw new Error('memory proposal timestamp must be canonical UTC ISO');
    }
  }
  if (record.entityIdentity !== undefined && record.entityIdentity !== 'canonical') {
    throw new Error("memory proposal entityIdentity must be 'canonical'");
  }
  if (record.checkSuite !== undefined) {
    if (typeof record.checkSuite !== 'string') {
      throw new Error('memory proposal checkSuite must be a string');
    }
    parseKnowledgeCheckSuite(record.checkSuite);
  }
  const addClauses = canonicalClauseList(record.addClauses, 'memory proposal addClauses');
  const removeClauses = canonicalClauseList(
    record.removeClauses,
    'memory proposal removeClauses'
  );
  if (addClauses.length === 0 && removeClauses.length === 0) {
    throw new Error('memory proposal contains no effective change');
  }
  const proposal = {
    ...record,
    addClauses,
    removeClauses,
  } as unknown as MemoryChangeProposal;
  const { proposalDigest, ...payload } = proposal;
  if (computeMemoryProposalDigest(payload) !== proposalDigest) {
    throw new Error('memory proposal digest does not match its content');
  }
  return proposal;
}

/** Parse either a standalone proposal or a complete propose-memory result. */
export function parseMemoryProposal(
  value: MemoryChangeProposal | string | unknown
): MemoryChangeProposal {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PROPOSAL_BYTES) {
      throw new Error(`memory proposal exceeds ${MAX_MEMORY_PROPOSAL_BYTES} bytes`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('memory proposal is not valid JSON');
    }
  }
  return parsedProposal(parsed);
}

function temporalArchives(proposal: MemoryChangeProposal): MemoryChangeTemporalArchive[] {
  if (proposal.validTimeMode === 'delete') return [];
  const additions = parseProgram(proposal.addClauses.join('\n'));
  return parseProgram(proposal.removeClauses.join('\n')).map((from) => {
    if (from.body.length !== 0 || from.head.predicate.endsWith('_until')) {
      throw new Error('memory proposal temporal removals must be current ground facts');
    }
    const expected: Clause = {
      head: {
        predicate: `${from.head.predicate}_until`,
        args: [
          ...structuredClone(from.head.args),
          { type: 'atom', value: proposal.at! },
        ],
      },
      body: [],
    };
    const match = additions.find(
      (candidate) => canonicalKey(candidate) === canonicalKey(expected)
    );
    if (match === undefined) {
      throw new Error('memory proposal is missing an exact temporal archive');
    }
    return {
      from: serializeClause(from),
      to: serializeClause(match),
      validUntil: proposal.at!,
    };
  });
}

/** Apply one explicitly reviewed current accepted-memory proposal. */
export function applyMemoryProposal(
  store: MemoryStore,
  proposalValue: MemoryChangeProposal | string | unknown,
  options: ApplyMemoryProposalOptions
): ApplyMemoryProposalResult {
  const proposal = parseMemoryProposal(proposalValue);
  if (typeof options.opId !== 'string' || options.opId.length === 0) {
    throw new Error('memory proposal application requires an explicit operation id');
  }
  const archives = temporalArchives(proposal);
  let checks: KnowledgeCheckSuiteResult | undefined;
  const mutation = store.applyMemoryChange(
    proposal.namespace,
    {
      namespaces: proposal.namespaces,
      expectedBaselineDigest: proposal.baselineDigest,
      proposalDigest: proposal.proposalDigest,
      add: proposal.addClauses.join('\n'),
      remove: proposal.removeClauses.join('\n'),
      temporalArchives: archives,
      validateCandidate(candidate) {
        auditKnowledgeRules(candidate.clauses, new Map(), {
          ...(options.maxFacts === undefined ? {} : { maxFacts: options.maxFacts }),
          ...(options.maxIterations === undefined
            ? {}
            : { maxIterations: options.maxIterations }),
          ...(proposal.entityIdentity === undefined
            ? {}
            : { entityIdentity: proposal.entityIdentity }),
        });
        if (proposal.checkSuite !== undefined) {
          checks = runKnowledgeChecks(
            candidate.clauses,
            new Map(),
            proposal.checkSuite,
            {
              ...(proposal.entityIdentity === undefined
                ? {}
                : { entityIdentity: proposal.entityIdentity }),
            }
          );
          if (checks.status !== 'passed') throw new MemoryChangeCheckError(checks);
        }
      },
    },
    {
      opId: options.opId,
      at: proposal.at === undefined ? options.at : new Date(proposal.at),
      sourceText: proposal.sourceText,
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
    }
  );
  const committed = store.recordedSnapshot(
    proposal.namespaces,
    mutation.sequence
  );
  const audit = auditKnowledgeRules(committed.clauses, committed.sources, {
    ...(options.maxFacts === undefined ? {} : { maxFacts: options.maxFacts }),
    ...(options.maxIterations === undefined
      ? {}
      : { maxIterations: options.maxIterations }),
    ...(proposal.entityIdentity === undefined
      ? {}
      : { entityIdentity: proposal.entityIdentity }),
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
      }
    );
  }
  return { ...mutation, audit, ...(checks === undefined ? {} : { checks }) };
}
