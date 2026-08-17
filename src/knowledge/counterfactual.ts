import { createHash } from 'node:crypto';
import {
  type Clause,
  type Literal,
  canonicalKey,
  isAggregateRule,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  literalMatches,
  parseProgram,
  parseQuery,
  serializeClause,
  serializeGoal,
} from '../engine/index.js';
import type {
  CurrentKnowledgeSnapshot,
  MemorySource,
  MemoryStore,
  RecordedKnowledgeSnapshot,
  RecordedSnapshotMetadata,
} from '../store/store.js';
import { assertBoundedInput, assertNamespaceCount } from '../safety.js';
import {
  explainKnowledge,
  type ExplainKnowledgeOptions,
  type ExplainKnowledgeResult,
  type ExplainedKnowledgeRow,
} from './graph.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from './integrity.js';
import {
  auditKnowledgeRules,
  type RuleAuditFinding,
  type RuleAuditResult,
} from './rule-audit.js';
import {
  runKnowledgeChecks,
  type KnowledgeCheckSuite,
  type KnowledgeCheckSuiteResult,
} from './checks.js';
import { isEntityMetadataPredicate } from './identity.js';
import { isTrustMetadataPredicate } from './trust.js';

export const MAX_COUNTERFACTUAL_ASSUMPTIONS = 64;
export const MAX_COUNTERFACTUAL_RETRACTIONS = 64;
export const MAX_COUNTERFACTUAL_RULE_ADDITIONS = 64;
export const MAX_COUNTERFACTUAL_RULE_REMOVALS = 64;
const HYPOTHETICAL_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface CounterfactualKnowledgeOptions
  extends Omit<ExplainKnowledgeOptions, 'metrics' | 'graphSelector'> {
  /** Namespace whose facts would change. Defaults to `default`. */
  namespace?: string;
  /** Complete knowledge view used by rules, constraints, identity, and trust projection. */
  namespaces?: string[] | '*';
  /** Ordinary ground facts to append after hypothetical retractions. */
  assume?: string;
  /** Ground-fact patterns to retract from the target namespace before assumptions. */
  without?: string[];
  /** Ordinary or aggregate rules to append after exact rule removals. */
  assumeRules?: string;
  /** Exact alpha-equivalent ordinary or aggregate rules to remove. */
  withoutRules?: string;
  /** Optional deterministic knowledge suite evaluated against both programs. */
  checkSuite?: KnowledgeCheckSuite | string;
  /** Simulate from an exact recorded journal position instead of current files. */
  recordedSequence?: number;
  /** Complete integrity-row cap applied independently to each view. */
  maxViolations?: number;
}

export interface CounterfactualViewOptions {
  namespace?: string;
  namespaces?: string[] | '*';
  assume?: string;
  without?: string[];
  assumeRules?: string;
  withoutRules?: string;
  recordedSequence?: number;
}

export interface CounterfactualBaseline {
  namespace: string;
  namespaces: string[];
  clauses: Clause[];
  clausesByNamespace: Map<string, Clause[]>;
  sources: Map<string, MemorySource[]>;
  recordedSnapshot?: RecordedSnapshotMetadata;
}

export interface CounterfactualKnowledgeView {
  baseline: CounterfactualBaseline;
  candidateClauses: Clause[];
  candidateSources: Map<string, MemorySource[]>;
  application: CounterfactualApplication;
}

export interface CounterfactualApplication {
  namespace: string;
  namespaces: string[];
  assumed: string[];
  duplicateAssumptions: string[];
  retracted: string[];
  unmatchedRetractions: string[];
  assumedRules: string[];
  duplicateRuleAssumptions: string[];
  retractedRules: string[];
  unmatchedRuleRetractions: string[];
}

export interface CounterfactualResultDelta {
  added: ExplainedKnowledgeRow[];
  removed: ExplainedKnowledgeRow[];
  evidenceChanged: Array<{
    before: ExplainedKnowledgeRow;
    after: ExplainedKnowledgeRow;
  }>;
  unchangedCount: number;
}

export interface CounterfactualIntegrityViolation {
  constraintId: string;
  clause: string;
  bindings: Record<string, string>;
}

export interface CounterfactualIntegrityDelta {
  baseline: IntegrityCheckResult;
  candidate: IntegrityCheckResult;
  introduced: CounterfactualIntegrityViolation[];
  resolved: CounterfactualIntegrityViolation[];
}

export interface CounterfactualRuleAuditDelta {
  baseline: RuleAuditResult;
  candidate: RuleAuditResult;
  introduced: RuleAuditFinding[];
  resolved: RuleAuditFinding[];
  addedTopologyNodeIds: string[];
  removedTopologyNodeIds: string[];
  changedTopologyNodeIds: string[];
  addedTopologyEdgeIds: string[];
  removedTopologyEdgeIds: string[];
  changedTopologyEdgeIds: string[];
}

export interface CounterfactualCheckDelta {
  baseline: KnowledgeCheckSuiteResult;
  candidate: KnowledgeCheckSuiteResult;
  regressed: string[];
  fixed: string[];
  coveragePercentBefore: number;
  coveragePercentAfter: number;
  coveragePercentDelta: number;
  coverageRegressed: boolean;
  coverageFixed: boolean;
}

export interface CounterfactualKnowledgeResult {
  changed: boolean;
  application: CounterfactualApplication;
  baseline: ExplainKnowledgeResult;
  candidate: ExplainKnowledgeResult;
  resultDelta: CounterfactualResultDelta;
  integrityDelta: CounterfactualIntegrityDelta;
  ruleAuditDelta?: CounterfactualRuleAuditDelta;
  checkDelta?: CounterfactualCheckDelta;
  recordedSnapshot?: RecordedSnapshotMetadata;
}

function isReservedPredicate(predicate: string): boolean {
  return isEntityMetadataPredicate(predicate) || isTrustMetadataPredicate(predicate);
}

function assumptionFacts(source: string | undefined): Clause[] {
  if (source === undefined || source.trim() === '') return [];
  assertBoundedInput(source, 'counterfactual assumptions');
  const clauses = parseProgram(source);
  if (clauses.length > MAX_COUNTERFACTUAL_ASSUMPTIONS) {
    throw new Error(
      `counterfactual assumptions exceed ${MAX_COUNTERFACTUAL_ASSUMPTIONS} facts`
    );
  }
  for (const clause of clauses) {
    if (
      isIntegrityConstraint(clause) ||
      isAggregateRule(clause) ||
      clause.body.length !== 0 ||
      clause.head.args.some(
        (term) =>
          (term.type !== 'atom' && term.type !== 'num') ||
          (term.type === 'num' && !Number.isFinite(term.value))
      )
    ) {
      throw new Error('counterfactual assumptions must be ordinary ground facts');
    }
    if (isReservedPredicate(clause.head.predicate)) {
      throw new Error('counterfactual assumptions may not change reserved metadata');
    }
  }
  return clauses;
}

function proposalRules(
  source: string | undefined,
  maximum: number,
  label: string
): Clause[] {
  if (source === undefined || source.trim() === '') return [];
  assertBoundedInput(source, label);
  const clauses = parseProgram(source);
  if (clauses.length > maximum) {
    throw new Error(`${label} exceed ${maximum} rules`);
  }
  for (const clause of clauses) {
    if (isIntegrityConstraint(clause) || clause.body.length === 0) {
      throw new Error(`${label} must contain ordinary or aggregate rules only`);
    }
    if (isReservedPredicate(clause.head.predicate)) {
      throw new Error(`${label} may not define reserved metadata`);
    }
  }
  return clauses;
}

function assumptionRules(source: string | undefined): Clause[] {
  return proposalRules(
    source,
    MAX_COUNTERFACTUAL_RULE_ADDITIONS,
    'counterfactual rule assumptions'
  );
}

function removalRules(source: string | undefined): Clause[] {
  return proposalRules(
    source,
    MAX_COUNTERFACTUAL_RULE_REMOVALS,
    'counterfactual rule removals'
  );
}

function retractionPatterns(values: string[] | undefined): Array<{
  literal: Literal;
  serialized: string;
}> {
  const requested = values ?? [];
  if (requested.length > MAX_COUNTERFACTUAL_RETRACTIONS) {
    throw new Error(
      `counterfactual retractions exceed ${MAX_COUNTERFACTUAL_RETRACTIONS} patterns`
    );
  }
  assertBoundedInput(requested.join('\n'), 'counterfactual retractions');
  return requested.map((value, index) => {
    assertBoundedInput(value, `counterfactual retraction ${index + 1}`);
    const goals = parseQuery(value);
    if (goals.length !== 1 || isComparison(goals[0]) || isNegation(goals[0])) {
      throw new Error(
        `counterfactual retraction ${index + 1} must be one positive fact pattern`
      );
    }
    const literal = goals[0] as Literal;
    if (isReservedPredicate(literal.predicate)) {
      throw new Error('counterfactual retractions may not change reserved metadata');
    }
    return { literal, serialized: serializeGoal(literal) };
  });
}

function selectedNamespaces(
  store: MemoryStore,
  target: string,
  requested: string[] | '*' | undefined
): string[] {
  const selected = requested ?? [target];
  assertNamespaceCount(selected);
  const names = selected === '*'
    ? [...new Set([...store.listNamespaces(), target])].sort()
    : [...new Set(selected)];
  if (names.length === 0) {
    throw new Error('counterfactual namespace view must not be empty');
  }
  if (!names.includes(target)) {
    throw new Error(`counterfactual namespaces must include target '${target}'`);
  }
  return names;
}

function hypotheticalSource(namespace: string, clause: Clause): MemorySource {
  const digest = createHash('sha256').update(serializeClause(clause)).digest('hex');
  return {
    namespace,
    opId: `counterfactual-${digest.slice(0, 32)}`,
    ts: HYPOTHETICAL_TIMESTAMP,
    hypothetical: true,
  };
}

function candidateSources(
  baseline: Map<string, MemorySource[]>,
  targetNamespace: string,
  targetClauses: Clause[],
  assumed: Clause[],
  namespaceOrder: Map<string, number>
): Map<string, MemorySource[]> {
  const targetKeys = new Set(targetClauses.map(canonicalKey));
  const result = new Map<string, MemorySource[]>();
  for (const [key, sources] of baseline) {
    const retained = sources
      .filter(
        (source) => source.namespace !== targetNamespace || targetKeys.has(key)
      )
      .map((source) => ({ ...source }));
    if (retained.length > 0) result.set(key, retained);
  }
  for (const clause of assumed) {
    const key = canonicalKey(clause);
    const sources = result.get(key) ?? [];
    sources.push(hypotheticalSource(targetNamespace, clause));
    sources.sort(
      (left, right) =>
        (namespaceOrder.get(left.namespace) ?? Number.MAX_SAFE_INTEGER) -
          (namespaceOrder.get(right.namespace) ?? Number.MAX_SAFE_INTEGER) ||
        left.opId.localeCompare(right.opId)
    );
    result.set(key, sources);
  }
  return result;
}

function rowKey(row: ExplainedKnowledgeRow): string {
  return JSON.stringify(Object.entries(row.bindings));
}

function resultDelta(
  baseline: ExplainKnowledgeResult,
  candidate: ExplainKnowledgeResult
): CounterfactualResultDelta {
  const before = new Map(baseline.rows.map((row) => [rowKey(row), row]));
  const after = new Map(candidate.rows.map((row) => [rowKey(row), row]));
  const added = candidate.rows.filter((row) => !before.has(rowKey(row)));
  const removed = baseline.rows.filter((row) => !after.has(rowKey(row)));
  const evidenceChanged: CounterfactualResultDelta['evidenceChanged'] = [];
  let unchangedCount = 0;
  for (const row of candidate.rows) {
    const prior = before.get(rowKey(row));
    if (prior === undefined) continue;
    if (JSON.stringify(prior) === JSON.stringify(row)) unchangedCount += 1;
    else evidenceChanged.push({ before: prior, after: row });
  }
  return { added, removed, evidenceChanged, unchangedCount };
}

function integrityViolations(
  result: IntegrityCheckResult
): Array<{ key: string; value: CounterfactualIntegrityViolation }> {
  return result.checks.flatMap((check) =>
    check.rows.map((row) => ({
      key: JSON.stringify([
        check.id,
        check.bindingOrder.map((name) => row.bindings[name]),
      ]),
      value: {
        constraintId: check.id,
        clause: check.clause,
        bindings: row.bindings,
      },
    }))
  );
}

function integrityDelta(
  baseline: IntegrityCheckResult,
  candidate: IntegrityCheckResult
): CounterfactualIntegrityDelta {
  const before = integrityViolations(baseline);
  const after = integrityViolations(candidate);
  const beforeKeys = new Set(before.map(({ key }) => key));
  const afterKeys = new Set(after.map(({ key }) => key));
  return {
    baseline,
    candidate,
    introduced: after
      .filter(({ key }) => !beforeKeys.has(key))
      .map(({ value }) => value),
    resolved: before
      .filter(({ key }) => !afterKeys.has(key))
      .map(({ value }) => value),
  };
}

function idDelta<T extends { id: string }>(
  baseline: readonly T[],
  candidate: readonly T[]
): { added: string[]; removed: string[] } {
  const before = new Set(baseline.map(({ id }) => id));
  const after = new Set(candidate.map(({ id }) => id));
  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
  };
}

function changedIds<T extends { id: string }>(
  baseline: readonly T[],
  candidate: readonly T[]
): string[] {
  const before = new Map(baseline.map((value) => [value.id, value]));
  return candidate
    .filter((value) => {
      const prior = before.get(value.id);
      return prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value);
    })
    .map(({ id }) => id)
    .sort();
}

function ruleAuditDelta(
  baseline: RuleAuditResult,
  candidate: RuleAuditResult
): CounterfactualRuleAuditDelta {
  const findings = idDelta(baseline.findings, candidate.findings);
  const baselineFindings = new Map(
    baseline.findings.map((finding) => [finding.id, finding])
  );
  const candidateFindings = new Map(
    candidate.findings.map((finding) => [finding.id, finding])
  );
  const topologyNodes = idDelta(
    baseline.topology.graph.nodes,
    candidate.topology.graph.nodes
  );
  const topologyEdges = idDelta(
    baseline.topology.graph.edges,
    candidate.topology.graph.edges
  );
  return {
    baseline,
    candidate,
    introduced: findings.added.map((id) => candidateFindings.get(id)!),
    resolved: findings.removed.map((id) => baselineFindings.get(id)!),
    addedTopologyNodeIds: topologyNodes.added,
    removedTopologyNodeIds: topologyNodes.removed,
    changedTopologyNodeIds: changedIds(
      baseline.topology.graph.nodes,
      candidate.topology.graph.nodes
    ),
    addedTopologyEdgeIds: topologyEdges.added,
    removedTopologyEdgeIds: topologyEdges.removed,
    changedTopologyEdgeIds: changedIds(
      baseline.topology.graph.edges,
      candidate.topology.graph.edges
    ),
  };
}

function checkDelta(
  baseline: KnowledgeCheckSuiteResult,
  candidate: KnowledgeCheckSuiteResult
): CounterfactualCheckDelta {
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
    coverageRegressed: baseline.coveragePassed && !candidate.coveragePassed,
    coverageFixed: !baseline.coveragePassed && candidate.coveragePassed,
  };
}

function baselineFromSnapshot(
  snapshot: CurrentKnowledgeSnapshot,
  namespace: string
): CounterfactualBaseline {
  return {
    namespace,
    namespaces: [...snapshot.namespaces],
    clauses: structuredClone(snapshot.clauses),
    clausesByNamespace: new Map(
      [...snapshot.clausesByNamespace].map(([name, clauses]) => [
        name,
        structuredClone(clauses),
      ])
    ),
    sources: new Map(
      [...snapshot.sources].map(([key, sources]) => [
        key,
        sources.map((source) => structuredClone(source)),
      ])
    ),
  };
}

function baselineFromRecordedSnapshot(
  snapshot: RecordedKnowledgeSnapshot,
  namespace: string
): CounterfactualBaseline {
  const clausesByNamespace = new Map(
    snapshot.namespaces.map((name) => [name, [] as Clause[]])
  );
  for (const clause of snapshot.clauses) {
    const key = canonicalKey(clause);
    const sourceNamespaces = new Set(
      (snapshot.sources.get(key) ?? []).map((source) => source.namespace)
    );
    for (const name of snapshot.namespaces) {
      if (sourceNamespaces.has(name)) clausesByNamespace.get(name)!.push(clause);
    }
  }
  return {
    namespace,
    namespaces: [...snapshot.namespaces],
    clauses: structuredClone(snapshot.clauses),
    clausesByNamespace: new Map(
      [...clausesByNamespace].map(([name, clauses]) => [
        name,
        structuredClone(clauses),
      ])
    ),
    sources: new Map(
      [...snapshot.sources].map(([key, sources]) => [
        key,
        sources.map((source) => structuredClone(source)),
      ])
    ),
    recordedSnapshot: {
      sequence: snapshot.sequence,
      journalEntries: snapshot.journalEntries,
      namespaces: [...snapshot.namespaces],
    },
  };
}

/** Capture one coherent current view for one or more hypothetical applications. */
export function captureCounterfactualBaseline(
  store: MemoryStore,
  options: Pick<
    CounterfactualViewOptions,
    'namespace' | 'namespaces' | 'recordedSequence'
  > = {}
): CounterfactualBaseline {
  const namespace = options.namespace ?? 'default';
  if (options.recordedSequence !== undefined) {
    const requested = options.namespaces ?? [namespace];
    assertNamespaceCount(requested);
    let snapshot = store.recordedSnapshot(requested, options.recordedSequence);
    if (!snapshot.namespaces.includes(namespace)) {
      snapshot = store.recordedSnapshot(
        [...snapshot.namespaces, namespace],
        options.recordedSequence
      );
    }
    return baselineFromRecordedSnapshot(snapshot, namespace);
  }
  const names = selectedNamespaces(store, namespace, options.namespaces);
  return baselineFromSnapshot(store.knowledgeSnapshot(names), namespace);
}

/** Apply validated fact-only changes to an already captured in-memory baseline. */
export function applyCounterfactualChanges(
  baseline: CounterfactualBaseline,
  options: Pick<
    CounterfactualViewOptions,
    'assume' | 'without' | 'assumeRules' | 'withoutRules'
  > = {}
): CounterfactualKnowledgeView {
  const namespace = baseline.namespace;
  if (!baseline.namespaces.includes(namespace)) {
    throw new Error(`counterfactual namespaces must include target '${namespace}'`);
  }
  const namespaceOrder = new Map(
    baseline.namespaces.map((name, index) => [name, index])
  );
  const assumptions = assumptionFacts(options.assume);
  const patterns = retractionPatterns(options.without);
  const proposedRules = assumptionRules(options.assumeRules);
  const requestedRuleRemovals = removalRules(options.withoutRules);
  const targetBaseline = baseline.clausesByNamespace.get(namespace) ?? [];
  const matchingPatterns = patterns.map(({ literal }) =>
    targetBaseline.some(
      (clause) => clause.body.length === 0 && literalMatches(literal, clause.head)
    )
  );
  const retracted = targetBaseline.filter(
    (clause) =>
      clause.body.length === 0 &&
      patterns.some(({ literal }) => literalMatches(literal, clause.head))
  );
  const retractedKeys = new Set(retracted.map(canonicalKey));
  const targetRuleKeys = new Set(
    targetBaseline
      .filter((clause) => clause.body.length > 0 && !isIntegrityConstraint(clause))
      .map(canonicalKey)
  );
  const requestedRuleKeys = new Set(requestedRuleRemovals.map(canonicalKey));
  const retractedRules = targetBaseline.filter(
    (clause) =>
      clause.body.length > 0 &&
      !isIntegrityConstraint(clause) &&
      requestedRuleKeys.has(canonicalKey(clause))
  );
  const retractedRuleKeys = new Set(retractedRules.map(canonicalKey));
  const targetAfterRetractions = targetBaseline.filter(
    (clause) =>
      !retractedKeys.has(canonicalKey(clause)) &&
      !retractedRuleKeys.has(canonicalKey(clause))
  );
  const targetKeys = new Set(targetAfterRetractions.map(canonicalKey));
  const assumed: Clause[] = [];
  const duplicates: Clause[] = [];
  for (const clause of assumptions) {
    const key = canonicalKey(clause);
    if (targetKeys.has(key)) duplicates.push(clause);
    else {
      targetKeys.add(key);
      assumed.push(clause);
    }
  }
  const assumedRules: Clause[] = [];
  const duplicateRules: Clause[] = [];
  for (const clause of proposedRules) {
    const key = canonicalKey(clause);
    if (targetKeys.has(key)) duplicateRules.push(clause);
    else {
      targetKeys.add(key);
      assumedRules.push(clause);
    }
  }
  const candidateTarget = [
    ...targetAfterRetractions,
    ...assumed,
    ...assumedRules,
  ];
  const candidateClauses = baseline.namespaces.flatMap((name) =>
    name === namespace
      ? candidateTarget
      : baseline.clausesByNamespace.get(name) ?? []
  );
  return {
    baseline,
    candidateClauses,
    candidateSources: candidateSources(
      baseline.sources,
      namespace,
      candidateTarget,
      [...assumed, ...assumedRules],
      namespaceOrder
    ),
    application: {
      namespace,
      namespaces: [...baseline.namespaces],
      assumed: assumed.map(serializeClause),
      duplicateAssumptions: duplicates.map(serializeClause),
      retracted: retracted.map(serializeClause),
      unmatchedRetractions: patterns
        .filter((_pattern, index) => !matchingPatterns[index])
        .map(({ serialized }) => serialized),
      assumedRules: assumedRules.map(serializeClause),
      duplicateRuleAssumptions: duplicateRules.map(serializeClause),
      retractedRules: retractedRules.map(serializeClause),
      unmatchedRuleRetractions: requestedRuleRemovals
        .filter((clause) => !targetRuleKeys.has(canonicalKey(clause)))
        .map(serializeClause),
    },
  };
}

export function buildCounterfactualKnowledgeView(
  store: MemoryStore,
  options: CounterfactualViewOptions = {}
): CounterfactualKnowledgeView {
  const baseline = captureCounterfactualBaseline(store, options);
  return applyCounterfactualChanges(baseline, options);
}

export function evaluateCounterfactualKnowledgeView(
  view: CounterfactualKnowledgeView,
  query: string,
  options: Omit<
    CounterfactualKnowledgeOptions,
    | 'namespace'
    | 'namespaces'
    | 'assume'
    | 'without'
    | 'assumeRules'
    | 'withoutRules'
    | 'recordedSequence'
  > = {}
): CounterfactualKnowledgeResult {
  assertBoundedInput(query, 'counterfactual query');
  const { maxViolations, checkSuite, ...explainOptions } = options;
  const baselineExplanation = explainKnowledge(
    view.baseline.clauses,
    query,
    view.baseline.sources,
    explainOptions
  );
  const candidate = explainKnowledge(
    view.candidateClauses,
    query,
    view.candidateSources,
    explainOptions
  );
  const {
    maxRows: _maxRows,
    maxAggregateRows: _maxAggregateRows,
    maxAggregateProofRows: _maxAggregateProofRows,
    ...sharedIntegrityOptions
  } = explainOptions;
  const integrityOptions = {
    ...sharedIntegrityOptions,
    ...(maxViolations === undefined ? {} : { maxViolations }),
  };
  const baselineIntegrity = checkIntegrity(
    view.baseline.clauses,
    view.baseline.sources,
    integrityOptions
  );
  const candidateIntegrity = checkIntegrity(
    view.candidateClauses,
    view.candidateSources,
    integrityOptions
  );
  const rulesChanged =
    view.application.assumedRules.length > 0 ||
    view.application.retractedRules.length > 0;
  let auditDelta: CounterfactualRuleAuditDelta | undefined;
  if (rulesChanged) {
    const auditOptions = {
      ...(explainOptions.maxFacts === undefined
        ? {}
        : { maxFacts: explainOptions.maxFacts }),
      ...(explainOptions.maxIterations === undefined
        ? {}
        : { maxIterations: explainOptions.maxIterations }),
      ...(explainOptions.relationIndex === undefined
        ? {}
        : { relationIndex: explainOptions.relationIndex }),
      ...(explainOptions.entityIdentity === undefined
        ? {}
        : { entityIdentity: explainOptions.entityIdentity }),
      ...(explainOptions.trustMode === undefined
        ? {}
        : { trustMode: explainOptions.trustMode }),
    };
    auditDelta = ruleAuditDelta(
      auditKnowledgeRules(
        view.baseline.clauses,
        view.baseline.sources,
        auditOptions
      ),
      auditKnowledgeRules(
        view.candidateClauses,
        view.candidateSources,
        auditOptions
      )
    );
  }
  const suiteDelta = checkSuite === undefined
    ? undefined
    : checkDelta(
        runKnowledgeChecks(
          view.baseline.clauses,
          view.baseline.sources,
          checkSuite,
          explainOptions
        ),
        runKnowledgeChecks(
          view.candidateClauses,
          view.candidateSources,
          checkSuite,
          explainOptions
        )
      );
  return {
    changed:
      view.application.assumed.length > 0 ||
      view.application.retracted.length > 0 ||
      rulesChanged,
    application: structuredClone(view.application),
    baseline: baselineExplanation,
    candidate,
    resultDelta: resultDelta(baselineExplanation, candidate),
    integrityDelta: integrityDelta(baselineIntegrity, candidateIntegrity),
    ...(auditDelta === undefined ? {} : { ruleAuditDelta: auditDelta }),
    ...(suiteDelta === undefined ? {} : { checkDelta: suiteDelta }),
    ...(view.baseline.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: structuredClone(view.baseline.recordedSnapshot) }),
  };
}

/**
 * Evaluate a fact-only hypothetical change against the complete selected knowledge view.
 * The operation never calls a writer or creates a journal/source artifact.
 */
export function simulateKnowledge(
  store: MemoryStore,
  query: string,
  options: CounterfactualKnowledgeOptions = {}
): CounterfactualKnowledgeResult {
  const {
    namespace,
    namespaces,
    assume,
    without,
    assumeRules,
    withoutRules,
    recordedSequence,
    ...explainOptions
  } = options;
  const view = buildCounterfactualKnowledgeView(store, {
    namespace,
    namespaces,
    assume,
    without,
    assumeRules,
    withoutRules,
    recordedSequence,
  });
  return evaluateCounterfactualKnowledgeView(view, query, explainOptions);
}
