import { createHash } from 'node:crypto';
import {
  type Clause,
  parseProgram,
  serializeClause,
  serializeGoal,
} from '../engine/index.js';
import {
  extractRememberText,
  type PipelineDeps,
  type RememberOptions,
} from '../llm/pipeline.js';
import { knowledgeProgramDigest } from '../store/store.js';
import {
  applyCounterfactualChanges,
  captureCounterfactualBaseline,
  evaluateCounterfactualKnowledgeView,
  type CounterfactualApplication,
  type CounterfactualCheckDelta,
  type CounterfactualIntegrityDelta,
  type CounterfactualRuleAuditDelta,
} from './counterfactual.js';
import type { EntityIdentityMode } from './identity.js';
import {
  parseKnowledgeCheckSuite,
  type KnowledgeCheckSuite,
} from './checks.js';

export const MEMORY_PROPOSAL_VERSION = 1;

export interface ProposeRememberOptions
  extends Omit<RememberOptions, 'trust'> {
  /** Complete knowledge view used for consequence and integrity evaluation. */
  namespaces?: string[] | '*';
  /** Optional deterministic regression and semantic coverage suite. */
  checkSuite?: KnowledgeCheckSuite | string;
}

export interface MemoryChangeProposal {
  version: typeof MEMORY_PROPOSAL_VERSION;
  proposalDigest: string;
  baselineDigest: string;
  namespace: string;
  namespaces: string[];
  sourceText: string;
  validTimeMode: 'delete' | 'archive_until';
  at?: string;
  addClauses: string[];
  removeClauses: string[];
  entityIdentity?: EntityIdentityMode;
  checkSuite?: string;
}

export interface ProposeRememberResult {
  changed: boolean;
  extractedClauses: string[];
  extractedRetractions: string[];
  application: CounterfactualApplication;
  integrityDelta: CounterfactualIntegrityDelta;
  ruleAuditDelta?: CounterfactualRuleAuditDelta;
  checkDelta?: CounterfactualCheckDelta;
  proposal?: MemoryChangeProposal;
}

export function computeMemoryProposalDigest(
  proposal: Omit<MemoryChangeProposal, 'proposalDigest'>
): string {
  return createHash('sha256')
    .update(JSON.stringify(proposal))
    .digest('hex');
}

function archivedClause(clause: Clause, at: string): Clause {
  if (clause.body.length !== 0) {
    throw new Error('only facts can receive valid-time archive projection');
  }
  return {
    head: {
      predicate: `${clause.head.predicate}_until`,
      args: [
        ...structuredClone(clause.head.args),
        { type: 'atom', value: at },
      ],
    },
    body: [],
  };
}

function configuredNamespaces(
  deps: PipelineDeps,
  namespace: string,
  requested: string[] | '*' | undefined,
  integrity: RememberOptions['integrityEnforcement']
): string[] | '*' {
  if (requested !== undefined) return requested;
  const configured = integrity ?? deps.integrityEnforcement;
  if (configured !== undefined && configured !== false) {
    return configured.namespaces ?? [namespace];
  }
  return [namespace];
}

/**
 * Ask the model for memory changes, then evaluate an immutable accepted-knowledge
 * candidate and emit a digest-bound proposal. No store writer is called.
 */
export async function proposeRememberText(
  deps: PipelineDeps,
  text: string,
  namespace = 'default',
  options: ProposeRememberOptions = {}
): Promise<ProposeRememberResult> {
  const validTimeMode = options.validTimeMode ?? deps.validTimeMode ?? 'delete';
  if (validTimeMode !== 'delete' && validTimeMode !== 'archive_until') {
    throw new Error("valid-time mode must be 'delete' or 'archive_until'");
  }
  const extraction = await extractRememberText(
    deps,
    text,
    namespace,
    { ...options, trust: 'accepted' }
  );
  const namespaces = configuredNamespaces(
    deps,
    namespace,
    options.namespaces,
    options.integrityEnforcement
  );
  const baseline = captureCounterfactualBaseline(deps.store, {
    namespace,
    namespaces,
  });
  const extractedClauses = extraction?.clauses.map(serializeClause) ?? [];
  const extractedRetractions = extraction?.retractions.map((goals) =>
    goals.map(serializeGoal).join(', ')
  ) ?? [];
  const extractedFacts = extraction?.clauses.filter(
    (clause) => clause.body.length === 0
  ) ?? [];
  const extractedRules = extraction?.clauses.filter(
    (clause) => clause.body.length > 0
  ) ?? [];
  const preliminary = applyCounterfactualChanges(baseline, {
    assume: extractedFacts.map(serializeClause).join('\n'),
    assumeRules: extractedRules.map(serializeClause).join('\n'),
    without: extractedRetractions,
  });
  const at = validTimeMode === 'archive_until'
    ? (options.at ?? new Date()).toISOString()
    : undefined;
  const archives = at === undefined
    ? []
    : preliminary.application.retracted.map((serialized) => {
        const clauses = parseSingleClause(serialized);
        return archivedClause(clauses, at);
      });
  const view = archives.length === 0
    ? preliminary
    : applyCounterfactualChanges(baseline, {
        assume: [...extractedFacts, ...archives].map(serializeClause).join('\n'),
        assumeRules: extractedRules.map(serializeClause).join('\n'),
        without: extractedRetractions,
      });
  const configuredIdentity = options.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const configuredIntegrity = options.integrityEnforcement ?? deps.integrityEnforcement;
  const impact = evaluateCounterfactualKnowledgeView(
    view,
    'rembero_memory_proposal_probe',
    {
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(configuredIntegrity === undefined || configuredIntegrity === false
        ? {}
        : {
            maxProofsPerRow: configuredIntegrity.maxProofsPerRow,
            maxProofDepth: configuredIntegrity.maxProofDepth,
            maxProofNodes: configuredIntegrity.maxProofNodes,
            maxProofEnumerationSteps:
              configuredIntegrity.maxProofEnumerationSteps,
            maxFacts: configuredIntegrity.maxFacts,
            maxIterations: configuredIntegrity.maxIterations,
            maxViolations: configuredIntegrity.maxViolations,
            relationIndex: configuredIntegrity.relationIndex,
          }),
      ...(options.checkSuite === undefined
        ? {}
        : { checkSuite: options.checkSuite }),
    }
  );
  const addClauses = [
    ...impact.application.assumed,
    ...impact.application.assumedRules,
  ];
  const removeClauses = [...impact.application.retracted];
  const changed = addClauses.length > 0 || removeClauses.length > 0;
  if (!changed) {
    return {
      changed: false,
      extractedClauses,
      extractedRetractions,
      application: impact.application,
      integrityDelta: impact.integrityDelta,
      ...(impact.ruleAuditDelta === undefined
        ? {}
        : { ruleAuditDelta: impact.ruleAuditDelta }),
      ...(impact.checkDelta === undefined ? {} : { checkDelta: impact.checkDelta }),
    };
  }
  const payload: Omit<MemoryChangeProposal, 'proposalDigest'> = {
    version: MEMORY_PROPOSAL_VERSION,
    baselineDigest: knowledgeProgramDigest(
      baseline.namespaces,
      baseline.clausesByNamespace
    ),
    namespace,
    namespaces: [...baseline.namespaces],
    sourceText: text,
    validTimeMode,
    ...(at === undefined ? {} : { at }),
    addClauses,
    removeClauses,
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(options.checkSuite === undefined
      ? {}
      : { checkSuite: JSON.stringify(parseKnowledgeCheckSuite(options.checkSuite)) }),
  };
  return {
    changed: true,
    extractedClauses,
    extractedRetractions,
    application: impact.application,
    integrityDelta: impact.integrityDelta,
    ...(impact.ruleAuditDelta === undefined
      ? {}
      : { ruleAuditDelta: impact.ruleAuditDelta }),
    ...(impact.checkDelta === undefined ? {} : { checkDelta: impact.checkDelta }),
    proposal: {
      ...payload,
      proposalDigest: computeMemoryProposalDigest(payload),
    },
  };
}

function parseSingleClause(serialized: string): Clause {
  const clauses = parseProgram(serialized);
  if (clauses.length !== 1) throw new Error('expected one exact retracted fact');
  return clauses[0];
}
