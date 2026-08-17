import {
  evaluateQuerySpec,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  parseProgram,
  parseQuerySpec,
  predKey,
  serializeClause,
  serializeTerm,
} from '../engine/index.js';
import {
  type RecallResult,
  type RecallAnswerMode,
  type RememberResult,
  type PipelineDeps,
  recallQuestion,
  rememberText,
} from '../llm/pipeline.js';
import type {
  MemoryHistory,
  MemorySource,
  MemoryStore,
  JournalCheckpointArtifact,
  JournalCompactionResult,
  RecordedSnapshotMetadata,
  SupersedeResult,
} from '../store/store.js';
import type { Clause } from '../engine/index.js';
import { explainKnowledge, type ExplainKnowledgeResult } from '../knowledge/graph.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from '../knowledge/integrity.js';
import {
  inspectConflicts,
  type ConflictViewResult,
} from '../knowledge/conflicts.js';
import {
  simulateKnowledge,
  type CounterfactualKnowledgeResult,
} from '../knowledge/counterfactual.js';
import {
  explainWhyNot,
  type ExplainWhyNotResult,
} from '../knowledge/why-not.js';
import {
  analyzeKnowledgeTopology,
  type KnowledgeTopologyResult,
  type TopologyDirection,
} from '../knowledge/topology.js';
import {
  diffRecordedKnowledge,
  type RecordedKnowledgeDiffResult,
} from '../knowledge/recorded-diff.js';
import {
  planKnowledgeRepair,
  type RepairPlanResult,
} from '../knowledge/repair.js';
import {
  auditKnowledgeRules,
  type RuleAuditResult,
} from '../knowledge/rule-audit.js';
import {
  searchKnowledge,
  type KnowledgeSearchClauseKind,
  type KnowledgeSearchResult,
} from '../knowledge/search.js';
import {
  browseKnowledgeGraph,
  type BrowseKnowledgeGraphResult,
} from '../knowledge/browse.js';
import {
  connectKnowledgeGraph,
  type ConnectKnowledgeGraphResult,
} from '../knowledge/paths.js';
import {
  createKnowledgeBundle,
  verifyKnowledgeBundle,
  type KnowledgeBundle,
  type KnowledgeBundleVerification,
} from '../knowledge/bundle.js';
import {
  MAX_KNOWLEDGE_CHECK_SUITE_BYTES,
  runKnowledgeChecks,
  type KnowledgeCheckSuiteResult,
} from '../knowledge/checks.js';
import {
  profileKnowledge,
  type ProfileKnowledgeResult,
} from '../knowledge/profile.js';
import {
  applyRuleChangeProposal,
  type ApplyRuleChangeProposalResult,
} from '../knowledge/rule-change.js';
import {
  proposeRememberText,
  type ProposeRememberResult,
} from '../knowledge/memory-proposal.js';
import {
  applyMemoryProposal,
  type ApplyMemoryProposalResult,
} from '../knowledge/memory-application.js';
import type { IntegrityEnforcementOptions } from '../knowledge/enforcement.js';
import {
  EntityIdentityError,
  buildEntityResolver,
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityAlias,
  type EntityIdentityMode,
  type EntityPosition,
  type EntityResolver,
} from '../knowledge/identity.js';
import { assertBoundedInput, assertNamespaceCount } from '../safety.js';
import type { ExplanationGraphSelector } from '../knowledge/graph-navigation.js';
import {
  assertTentativeFacts,
  resolveTentativeFacts,
  reviewTentativeClaims,
  type StoredTentativeClaim,
  type TentativeAssertionResult,
  type TentativeResolutionResult,
} from '../knowledge/trust-store.js';
import {
  isTentativeDeclaration,
  TrustMetadataError,
  type KnowledgeTrust,
  type TentativeResolutionAction,
  type TrustViewMode,
} from '../knowledge/trust.js';

export type LlmToolDeps = PipelineDeps;

export interface StoreToolDeps {
  store: MemoryStore;
  integrityEnforcement?: IntegrityEnforcementOptions | false;
  entityIdentity?: EntityIdentityMode | false;
  trustMode?: TrustViewMode | false;
}

type NamespacesArg = string[] | '*' | undefined;

const namespacesOrDefault = (namespaces: NamespacesArg): string[] | '*' => {
  const resolved = namespaces ?? ['default'];
  assertNamespaceCount(resolved);
  return resolved;
};

function configuredTrustMode(
  deps: StoreToolDeps,
  requested: TrustViewMode | undefined
): TrustViewMode {
  const configured = requested ?? deps.trustMode;
  return configured === false || configured === undefined ? 'accepted' : configured;
}

function recordedView(
  store: MemoryStore,
  namespaces: string[] | '*',
  sequence?: number
): {
  clauses: Clause[];
  sources: Map<string, MemorySource[]>;
  recordedSnapshot?: RecordedSnapshotMetadata;
} {
  if (sequence === undefined) {
    const snapshot = store.knowledgeSnapshot(namespaces);
    return { clauses: snapshot.clauses, sources: snapshot.sources };
  }
  const snapshot = store.recordedSnapshot(namespaces, sequence);
  return {
    clauses: snapshot.clauses,
    sources: snapshot.sources,
    recordedSnapshot: {
      sequence: snapshot.sequence,
      journalEntries: snapshot.journalEntries,
      namespaces: snapshot.namespaces,
    },
  };
}

export function rememberTool(
  deps: LlmToolDeps,
  args: {
    text: string;
    namespace?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
    entityIdentity?: EntityIdentityMode;
    trust?: KnowledgeTrust;
  }
): Promise<RememberResult> {
  assertBoundedInput(args.text, 'memory text');
  return rememberText(deps, args.text, args.namespace ?? 'default', {
    ...(args.integrityEnforcement === undefined
      ? {}
      : { integrityEnforcement: args.integrityEnforcement }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
    ...(args.trust === undefined ? {} : { trust: args.trust }),
  });
}

export function proposeMemoryTool(
  deps: LlmToolDeps,
  args: {
    text: string;
    namespace?: string;
    namespaces?: string[] | '*';
    validTimeMode?: 'delete' | 'archive_until';
    at?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
    entityIdentity?: EntityIdentityMode;
  }
): Promise<ProposeRememberResult> {
  assertBoundedInput(args.text, 'memory text');
  let at: Date | undefined;
  if (args.at !== undefined) {
    at = new Date(args.at);
    if (Number.isNaN(at.getTime()) || at.toISOString() !== args.at) {
      throw new Error('memory proposal timestamp must be canonical UTC ISO');
    }
  }
  return proposeRememberText(
    deps,
    args.text,
    args.namespace ?? 'default',
    {
      ...(args.namespaces === undefined ? {} : { namespaces: args.namespaces }),
      ...(args.validTimeMode === undefined
        ? {}
        : { validTimeMode: args.validTimeMode }),
      ...(at === undefined ? {} : { at }),
      ...(args.integrityEnforcement === undefined
        ? {}
        : { integrityEnforcement: args.integrityEnforcement }),
      ...(args.entityIdentity === undefined
        ? {}
        : { entityIdentity: args.entityIdentity }),
    }
  );
}

export function applyMemoryProposalTool(
  deps: StoreToolDeps,
  args: {
    proposal: string;
    opId: string;
    maxViolations?: number;
  }
): ApplyMemoryProposalResult {
  return applyMemoryProposal(deps.store, args.proposal, {
    opId: args.opId,
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
  });
}

export function recallTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
    answerMode?: RecallAnswerMode;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
    ...(args.trustMode === undefined ? {} : { trustMode: args.trustMode }),
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
    ...(args.answerMode === undefined ? {} : { answerMode: args.answerMode }),
  });
}

export function recallExplainTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
    answerMode?: RecallAnswerMode;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    explain: true,
    ...(args.proofLimit === undefined ? {} : { proofLimit: args.proofLimit }),
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
    ...(args.trustMode === undefined ? {} : { trustMode: args.trustMode }),
    ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
    ...(args.answerMode === undefined ? {} : { answerMode: args.answerMode }),
  });
}

export function assertFactsTool(
  deps: StoreToolDeps,
  args: {
    clauses: string;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { added: string[]; duplicates: number; opId: string } {
  assertBoundedInput(args.clauses, 'clauses');
  const parsed = parseProgram(args.clauses);
  if (parsed.some(isTentativeDeclaration)) {
    throw new TrustMetadataError(
      'raw assertion may not assign trust metadata; use assert_tentative'
    );
  }
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  const { added, duplicates, opId } = deps.store.assert(
    args.namespace ?? 'default',
    parsed,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
  return { added: added.map(serializeClause), duplicates, opId };
}

export function assertTentativeTool(
  deps: StoreToolDeps,
  args: {
    clauses: string;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): TentativeAssertionResult {
  assertBoundedInput(args.clauses, 'tentative clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  return assertTentativeFacts(
    deps.store,
    args.namespace ?? 'default',
    args.clauses,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
}

export function reviewTentativeTool(
  deps: StoreToolDeps,
  args: { namespaces?: string[] | '*' }
): { claims: StoredTentativeClaim[]; count: number } {
  const claims = reviewTentativeClaims(
    deps.store,
    namespacesOrDefault(args.namespaces)
  );
  return { claims, count: claims.length };
}

export function resolveTentativeTool(
  deps: StoreToolDeps,
  args: {
    clauses: string;
    action: TentativeResolutionAction;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): TentativeResolutionResult {
  assertBoundedInput(args.clauses, 'tentative resolution clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  return resolveTentativeFacts(
    deps.store,
    args.namespace ?? 'default',
    args.clauses,
    args.action,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
}

export function validTimeInstant(value: string): Date {
  assertBoundedInput(value, 'valid-time instant');
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error(
      'valid-time instant must be a canonical UTC timestamp such as 2026-08-16T16:59:00.000Z'
    );
  }
  return instant;
}

export interface SupersedeFactsResult {
  added: string[];
  duplicates: number;
  retracted: number;
  archived: string[];
  opId: string;
}

export function supersedeFactsTool(
  deps: StoreToolDeps,
  args: {
    patterns: string[];
    replacements?: string;
    namespace?: string;
    at?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): SupersedeFactsResult {
  for (const pattern of args.patterns) assertBoundedInput(pattern, 'supersede pattern');
  assertBoundedInput(args.patterns.join('\n'), 'supersede patterns');
  const replacements = args.replacements ?? '';
  assertBoundedInput(replacements, 'replacement clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  const result: SupersedeResult = deps.store.supersede(
    args.namespace ?? 'default',
    args.patterns,
    replacements,
    {
      ...(args.at === undefined ? {} : { at: validTimeInstant(args.at) }),
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
  return {
    added: result.added.map(serializeClause),
    duplicates: result.duplicates,
    retracted: result.retracted,
    archived: result.archived.map(serializeClause),
    opId: result.opId,
  };
}

export function queryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): {
  bindings: Record<string, string>[];
  trustMode?: TrustViewMode;
  recordedSnapshot?: RecordedSnapshotMetadata;
} {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const { clauses, sources } = recorded;
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const view = entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sources, trustMode)
    : literalKnowledge(clauses, sources, trustMode);
  const parsed = parseQuerySpec(args.query);
  const query = entityIdentity === 'canonical'
    ? view.resolver.canonicalizeQuery(parsed).query
    : parsed;
  const bindings = evaluateQuerySpec(view.clauses, query).map((b) =>
    Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
  );
  return {
    bindings,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function explainQueryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): ExplainKnowledgeResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = explainKnowledge(
    recorded.clauses,
    args.query,
    recorded.sources,
    {
      ...(args.proofLimit === undefined ? {} : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
      ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    }
  );
  return {
    ...result,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function checkIntegrityTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): IntegrityCheckResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = checkIntegrity(
    recorded.clauses,
    recorded.sources,
    {
      ...(args.proofLimit === undefined
        ? {}
        : { maxProofsPerRow: args.proofLimit }),
      ...(args.maxViolations === undefined
        ? {}
        : { maxViolations: args.maxViolations }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
      ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    }
  );
  return {
    ...result,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function conflictViewsTool(
  deps: StoreToolDeps,
  args: {
    focus?: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): ConflictViewResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  if (args.focus !== undefined) assertBoundedInput(args.focus, 'conflict focus');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = inspectConflicts(recorded.clauses, recorded.sources, {
    ...(args.focus === undefined ? {} : { focus: args.focus }),
    ...(args.proofLimit === undefined
      ? {}
      : { maxProofsPerRow: args.proofLimit }),
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
  });
  return {
    ...result,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function whatIfTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    assume?: string;
    without?: string[];
    assumeRules?: string;
    withoutRules?: string;
    checkSuite?: string;
    namespace?: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): CounterfactualKnowledgeResult {
  assertBoundedInput(args.query, 'counterfactual query');
  if (args.assume !== undefined) {
    assertBoundedInput(args.assume, 'counterfactual assumptions');
  }
  for (const [index, pattern] of (args.without ?? []).entries()) {
    assertBoundedInput(pattern, `counterfactual retraction ${index + 1}`);
  }
  if (args.assumeRules !== undefined) {
    assertBoundedInput(args.assumeRules, 'counterfactual rule assumptions');
  }
  if (args.withoutRules !== undefined) {
    assertBoundedInput(args.withoutRules, 'counterfactual rule removals');
  }
  if (
    args.checkSuite !== undefined &&
    Buffer.byteLength(args.checkSuite, 'utf8') > MAX_KNOWLEDGE_CHECK_SUITE_BYTES
  ) {
    throw new Error(
      `counterfactual knowledge check suite exceeds ${MAX_KNOWLEDGE_CHECK_SUITE_BYTES} bytes`
    );
  }
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  return simulateKnowledge(deps.store, args.query, {
    ...(args.assume === undefined ? {} : { assume: args.assume }),
    ...(args.without === undefined ? {} : { without: args.without }),
    ...(args.assumeRules === undefined
      ? {}
      : { assumeRules: args.assumeRules }),
    ...(args.withoutRules === undefined
      ? {}
      : { withoutRules: args.withoutRules }),
    ...(args.checkSuite === undefined ? {} : { checkSuite: args.checkSuite }),
    ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
    ...(args.namespaces === undefined ? {} : { namespaces: args.namespaces }),
    ...(args.proofLimit === undefined
      ? {}
      : { maxProofsPerRow: args.proofLimit }),
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
  });
}

export function applyRuleChangeProposalTool(
  deps: StoreToolDeps,
  args: {
    proposal: string;
    opId: string;
    maxViolations?: number;
  }
): ApplyRuleChangeProposalResult {
  return applyRuleChangeProposal(deps.store, args.proposal, {
    opId: args.opId,
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
  });
}

export function whyNotTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
    maxFailures?: number;
    maxDiagnosticDepth?: number;
    maxCandidatesPerFailure?: number;
    maxEvidenceFacts?: number;
  }
): ExplainWhyNotResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.query, 'why-not query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = explainWhyNot(
    recorded.clauses,
    args.query,
    recorded.sources,
    {
      ...(args.proofLimit === undefined
        ? {}
        : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
      ...(args.maxFailures === undefined ? {} : { maxFailures: args.maxFailures }),
      ...(args.maxDiagnosticDepth === undefined
        ? {}
        : { maxDiagnosticDepth: args.maxDiagnosticDepth }),
      ...(args.maxCandidatesPerFailure === undefined
        ? {}
        : { maxCandidatesPerFailure: args.maxCandidatesPerFailure }),
      ...(args.maxEvidenceFacts === undefined
        ? {}
        : { maxEvidenceFacts: args.maxEvidenceFacts }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function topologyTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    focus?: string;
    direction?: TopologyDirection;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): KnowledgeTopologyResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  if (args.focus !== undefined) assertBoundedInput(args.focus, 'topology focus');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = analyzeKnowledgeTopology(recorded.clauses, recorded.sources, {
    ...(args.focus === undefined ? {} : { focus: args.focus }),
    ...(args.direction === undefined ? {} : { direction: args.direction }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  });
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function recordedDiffTool(
  deps: StoreToolDeps,
  args: {
    fromSequence: number;
    toSequence: number;
    namespaces?: string[] | '*';
    query?: string;
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
  }
): RecordedKnowledgeDiffResult {
  if (args.query !== undefined) assertBoundedInput(args.query, 'recorded diff query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  return diffRecordedKnowledge(deps.store, args.fromSequence, args.toSequence, {
    namespaces,
    ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.proofLimit === undefined
      ? {}
      : { maxProofsPerRow: args.proofLimit }),
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  });
}

export function repairPlanTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespace?: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    maxPlans?: number;
    maxSteps?: number;
    maxSearchStates?: number;
  }
): RepairPlanResult {
  assertBoundedInput(args.query, 'repair query');
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  return planKnowledgeRepair(deps.store, args.query, {
    ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
    ...(args.namespaces === undefined ? {} : { namespaces: args.namespaces }),
    ...(args.proofLimit === undefined
      ? {}
      : { maxProofsPerRow: args.proofLimit }),
    ...(args.maxViolations === undefined
      ? {}
      : { maxViolations: args.maxViolations }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(args.maxPlans === undefined ? {} : { maxPlans: args.maxPlans }),
    ...(args.maxSteps === undefined ? {} : { maxSteps: args.maxSteps }),
    ...(args.maxSearchStates === undefined
      ? {}
      : { maxSearchStates: args.maxSearchStates }),
  });
}

export function auditRulesTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    focus?: string;
    direction?: TopologyDirection;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): RuleAuditResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  if (args.focus !== undefined) assertBoundedInput(args.focus, 'rule audit focus');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = auditKnowledgeRules(recorded.clauses, recorded.sources, {
    ...(args.focus === undefined ? {} : { focus: args.focus }),
    ...(args.direction === undefined ? {} : { direction: args.direction }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  });
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function searchKnowledgeTool(
  deps: StoreToolDeps,
  args: {
    text: string;
    namespaces?: string[] | '*';
    limit?: number;
    kinds?: KnowledgeSearchClauseKind[];
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): KnowledgeSearchResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.text, 'knowledge search text');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = searchKnowledge(recorded.clauses, args.text, recorded.sources, {
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  });
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function browseKnowledgeGraphTool(
  deps: StoreToolDeps,
  args: {
    focus?: string | number;
    predicate?: string;
    depth?: number;
    maxClaims?: number;
    namespaces?: string[] | '*';
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): BrowseKnowledgeGraphResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  if (typeof args.focus === 'string') {
    assertBoundedInput(args.focus, 'knowledge graph entity focus');
  }
  if (args.predicate !== undefined) {
    assertBoundedInput(args.predicate, 'knowledge graph predicate focus');
  }
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = browseKnowledgeGraph(recorded.clauses, recorded.sources, {
    ...(args.focus === undefined ? {} : { focus: args.focus }),
    ...(args.predicate === undefined ? {} : { predicate: args.predicate }),
    ...(args.depth === undefined ? {} : { depth: args.depth }),
    ...(args.maxClaims === undefined ? {} : { maxClaims: args.maxClaims }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  });
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function connectKnowledgeGraphTool(
  deps: StoreToolDeps,
  args: {
    from: string | number;
    to: string | number;
    maxDepth?: number;
    maxPaths?: number;
    maxClaims?: number;
    includeDerived?: boolean;
    namespaces?: string[] | '*';
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): ConnectKnowledgeGraphResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  if (typeof args.from === 'string') {
    assertBoundedInput(args.from, 'knowledge graph path start');
  }
  if (typeof args.to === 'string') {
    assertBoundedInput(args.to, 'knowledge graph path end');
  }
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = connectKnowledgeGraph(
    recorded.clauses,
    recorded.sources,
    args.from,
    args.to,
    {
      ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
      ...(args.maxPaths === undefined ? {} : { maxPaths: args.maxPaths }),
      ...(args.maxClaims === undefined ? {} : { maxClaims: args.maxClaims }),
      ...(args.includeDerived === undefined
        ? {}
        : { includeDerived: args.includeDerived }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function exportKnowledgeBundleTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    recordedSequence?: number;
  }
): KnowledgeBundle {
  return createKnowledgeBundle(deps.store, {
    namespaces: args.namespaces ?? '*',
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
  });
}

export function verifyKnowledgeBundleTool(args: {
  bundle: string;
}): KnowledgeBundleVerification {
  return verifyKnowledgeBundle(args.bundle);
}

export function runKnowledgeChecksTool(
  deps: StoreToolDeps,
  args: {
    suite: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
    includePassingEvidence?: boolean;
  }
): KnowledgeCheckSuiteResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = runKnowledgeChecks(
    recorded.clauses,
    recorded.sources,
    args.suite,
    {
      ...(args.proofLimit === undefined
        ? {}
        : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
      ...(args.includePassingEvidence === undefined
        ? {}
        : { includePassingEvidence: args.includePassingEvidence }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function profileKnowledgeTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    trustMode?: TrustViewMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
    compareFullScan?: boolean;
  }
): ProfileKnowledgeResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.query, 'profile query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = profileKnowledge(
    recorded.clauses,
    args.query,
    recorded.sources,
    {
      ...(args.proofLimit === undefined
        ? {}
        : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(trustMode === 'accepted' ? {} : { trustMode }),
      ...(args.graphSelector === undefined
        ? {}
        : { graphSelector: args.graphSelector }),
      ...(args.compareFullScan === undefined
        ? {}
        : { compareFullScan: args.compareFullScan }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function forgetTool(
  deps: StoreToolDeps,
  args: {
    pattern: string;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { removed: number; opId: string } {
  assertBoundedInput(args.pattern, 'forget pattern');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  return deps.store.retract(
    args.namespace ?? 'default',
    args.pattern,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
}

export function historyTool(
  deps: StoreToolDeps,
  args: { pattern: string; namespaces?: string[] | '*'; limit?: number }
): MemoryHistory {
  assertBoundedInput(args.pattern, 'history pattern');
  const namespaces = namespacesOrDefault(args.namespaces);
  return deps.store.history(args.pattern, {
    namespaces,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
}

export function checkpointJournalTool(
  deps: StoreToolDeps,
  args: { opId?: string; at?: string; dryRun?: boolean }
): JournalCompactionResult {
  return deps.store.compactJournal({
    ...(args.opId === undefined ? {} : { opId: args.opId }),
    ...(args.at === undefined ? {} : { at: validTimeInstant(args.at) }),
    ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
  });
}

export function listCheckpointsTool(
  deps: StoreToolDeps
): { checkpoints: JournalCheckpointArtifact[]; count: number } {
  const checkpoints = deps.store.listJournalCheckpoints();
  return { checkpoints, count: checkpoints.length };
}

export interface PredicateGroup {
  predicate: string;
  facts: string[];
  rules?: string[];
}

export function listMemoriesTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    predicate?: string;
    trustMode?: TrustViewMode;
    recordedSequence?: number;
  }
): {
  predicates: PredicateGroup[];
  constraints?: string[];
  aliases?: EntityAlias[];
  entityPositions?: EntityPosition[];
  identityError?: { code: 'entity_identity_error'; message: string };
  trustMode?: TrustViewMode;
  recordedSnapshot?: RecordedSnapshotMetadata;
} {
  const namespaces = namespacesOrDefault(args.namespaces);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const storedClauses = recorded.clauses;
  const storedSources = recorded.sources;
  const trustMode = configuredTrustMode(deps, args.trustMode);
  const view = literalKnowledge(storedClauses, storedSources, trustMode);
  let resolver: EntityResolver | undefined;
  let identityError: { code: 'entity_identity_error'; message: string } | undefined;
  try {
    resolver = buildEntityResolver(storedClauses, storedSources);
  } catch (error) {
    if (!(error instanceof EntityIdentityError)) throw error;
    identityError = { code: error.code, message: error.message };
  }
  const clauses = view.clauses;
  const groups = new Map<string, PredicateGroup>();
  const constraints: string[] = [];
  for (const clause of clauses) {
    if (isIntegrityConstraint(clause)) {
      const matchesFilter =
        args.predicate === undefined ||
        clause.body.some((goal) => {
          if (isComparison(goal)) return false;
          const literal = isNegation(goal) ? goal.not : goal;
          return (
            literal.predicate === args.predicate ||
            predKey(literal) === args.predicate
          );
        });
      if (matchesFilter) constraints.push(serializeClause(clause));
      continue;
    }
    const key = predKey(clause.head);
    if (args.predicate && key !== args.predicate && clause.head.predicate !== args.predicate) {
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { predicate: key, facts: [] };
      groups.set(key, group);
    }
    if (clause.body.length === 0) {
      group.facts.push(serializeClause(clause));
    } else {
      (group.rules ??= []).push(serializeClause(clause));
    }
  }
  const aliases = resolver?.aliases() ?? [];
  const entityPositions = resolver?.positions() ?? [];
  return {
    predicates: [...groups.values()],
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(entityPositions.length === 0 ? {} : { entityPositions }),
    ...(identityError === undefined ? {} : { identityError }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}
