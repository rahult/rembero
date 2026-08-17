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
import type { MemorySource, MemoryStore } from '../store/store.js';
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
import { isEntityMetadataPredicate } from './identity.js';
import { isTrustMetadataPredicate } from './trust.js';

export const MAX_COUNTERFACTUAL_ASSUMPTIONS = 64;
export const MAX_COUNTERFACTUAL_RETRACTIONS = 64;
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
  /** Complete integrity-row cap applied independently to each view. */
  maxViolations?: number;
}

export interface CounterfactualApplication {
  namespace: string;
  namespaces: string[];
  assumed: string[];
  duplicateAssumptions: string[];
  retracted: string[];
  unmatchedRetractions: string[];
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

export interface CounterfactualKnowledgeResult {
  changed: boolean;
  application: CounterfactualApplication;
  baseline: ExplainKnowledgeResult;
  candidate: ExplainKnowledgeResult;
  resultDelta: CounterfactualResultDelta;
  integrityDelta: CounterfactualIntegrityDelta;
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

/**
 * Evaluate a fact-only hypothetical change against the complete selected knowledge view.
 * The operation never calls a writer or creates a journal/source artifact.
 */
export function simulateKnowledge(
  store: MemoryStore,
  query: string,
  options: CounterfactualKnowledgeOptions = {}
): CounterfactualKnowledgeResult {
  assertBoundedInput(query, 'counterfactual query');
  const {
    namespace = 'default',
    namespaces: requestedNamespaces,
    assume,
    without,
    maxViolations,
    ...explainOptions
  } = options;
  const names = selectedNamespaces(store, namespace, requestedNamespaces);
  const namespaceOrder = new Map(names.map((name, index) => [name, index]));
  const assumptions = assumptionFacts(assume);
  const patterns = retractionPatterns(without);
  const snapshot = store.knowledgeSnapshot(names);
  const baselineByNamespace = snapshot.clausesByNamespace;
  const targetBaseline = baselineByNamespace.get(namespace)!;

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
  const targetAfterRetractions = targetBaseline.filter(
    (clause) => !retractedKeys.has(canonicalKey(clause))
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
  const candidateTarget = [...targetAfterRetractions, ...assumed];
  const baselineClauses = snapshot.clauses;
  const candidateClauses = names.flatMap((name) =>
    name === namespace ? candidateTarget : baselineByNamespace.get(name) ?? []
  );
  const baselineSources = snapshot.sources;
  const simulatedSources = candidateSources(
    baselineSources,
    namespace,
    candidateTarget,
    assumed,
    namespaceOrder
  );

  const baseline = explainKnowledge(
    baselineClauses,
    query,
    baselineSources,
    explainOptions
  );
  const candidate = explainKnowledge(
    candidateClauses,
    query,
    simulatedSources,
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
    baselineClauses,
    baselineSources,
    integrityOptions
  );
  const candidateIntegrity = checkIntegrity(
    candidateClauses,
    simulatedSources,
    integrityOptions
  );
  return {
    changed: assumed.length > 0 || retracted.length > 0,
    application: {
      namespace,
      namespaces: names,
      assumed: assumed.map(serializeClause),
      duplicateAssumptions: duplicates.map(serializeClause),
      retracted: retracted.map(serializeClause),
      unmatchedRetractions: patterns
        .filter((_pattern, index) => !matchingPatterns[index])
        .map(({ serialized }) => serialized),
    },
    baseline,
    candidate,
    resultDelta: resultDelta(baseline, candidate),
    integrityDelta: integrityDelta(baselineIntegrity, candidateIntegrity),
  };
}
