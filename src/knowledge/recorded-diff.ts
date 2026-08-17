import {
  type Clause,
  canonicalKey,
  isIntegrityConstraint,
  serializeClause,
  EngineLimitError,
} from '../engine/index.js';
import type {
  MemorySource,
  MemoryStore,
  RecordedSnapshotMetadata,
} from '../store/store.js';
import {
  explainKnowledge,
  type ExplainKnowledgeResult,
  type ExplainedKnowledgeRow,
} from './graph.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from './integrity.js';
import {
  canonicalizeKnowledge,
  isEntityMetadataDeclaration,
  literalKnowledge,
  type EntityIdentityMode,
} from './identity.js';
import {
  analyzeKnowledgeTopology,
  type KnowledgeTopologyEdge,
  type KnowledgeTopologyNode,
  type RecursivePredicateComponent,
} from './topology.js';
import type { TrustViewMode } from './trust.js';
import { isTentativeDeclaration } from './trust.js';

export const MAX_RECORDED_DIFF_CHANGES = 10_000;

export type RecordedClauseKind = 'fact' | 'rule' | 'constraint' | 'identity_metadata';

export interface RecordedClauseState {
  kind: RecordedClauseKind;
  clause: string;
  sources: MemorySource[];
}

export interface RecordedClauseSourceChange {
  kind: RecordedClauseKind;
  beforeClause: string;
  afterClause: string;
  beforeSources: MemorySource[];
  afterSources: MemorySource[];
}

export interface RecordedClauseDelta {
  added: RecordedClauseState[];
  removed: RecordedClauseState[];
  sourceChanged: RecordedClauseSourceChange[];
}

export interface RecordedTopologyNodeChange {
  before: KnowledgeTopologyNode;
  after: KnowledgeTopologyNode;
}

export interface RecordedTopologyDelta {
  before: {
    predicateCount: number;
    factCount: number;
    ruleCount: number;
    constraintCount: number;
    edgeCount: number;
  };
  after: {
    predicateCount: number;
    factCount: number;
    ruleCount: number;
    constraintCount: number;
    edgeCount: number;
  };
  addedNodes: KnowledgeTopologyNode[];
  removedNodes: KnowledgeTopologyNode[];
  changedNodes: RecordedTopologyNodeChange[];
  addedEdges: KnowledgeTopologyEdge[];
  removedEdges: KnowledgeTopologyEdge[];
  openInputsAdded: string[];
  openInputsRemoved: string[];
  openNegatedInputsAdded: string[];
  openNegatedInputsRemoved: string[];
  recursionAdded: RecursivePredicateComponent[];
  recursionRemoved: RecursivePredicateComponent[];
}

export interface RecordedIntegrityViolationChange {
  constraintId: string;
  clause: string;
  bindings: Record<string, string>;
  row: ExplainedKnowledgeRow;
}

export interface RecordedIntegrityDelta {
  before: IntegrityCheckResult;
  after: IntegrityCheckResult;
  introduced: RecordedIntegrityViolationChange[];
  resolved: RecordedIntegrityViolationChange[];
}

export interface RecordedQueryImpact {
  query: string;
  before: ExplainKnowledgeResult;
  after: ExplainKnowledgeResult;
  added: ExplainedKnowledgeRow[];
  removed: ExplainedKnowledgeRow[];
  evidenceChanged: Array<{
    before: ExplainedKnowledgeRow;
    after: ExplainedKnowledgeRow;
  }>;
  unchangedCount: number;
}

export interface RecordedKnowledgeDiffOptions {
  namespaces?: string[] | '*';
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
  query?: string;
  maxProofsPerRow?: number;
  maxViolations?: number;
}

export interface RecordedKnowledgeDiffResult {
  changed: boolean;
  from: RecordedSnapshotMetadata;
  to: RecordedSnapshotMetadata;
  journalEntriesTraversed: number;
  clauses: RecordedClauseDelta;
  topology: RecordedTopologyDelta;
  integrity: RecordedIntegrityDelta;
  queryImpact?: RecordedQueryImpact;
  trustMode?: TrustViewMode;
}

interface ClauseEntry {
  clause: Clause;
  serialized: string;
  kind: RecordedClauseKind;
  sources: MemorySource[];
}

function clauseKind(clause: Clause): RecordedClauseKind {
  if (isIntegrityConstraint(clause)) return 'constraint';
  return clause.body.length === 0 ? 'fact' : 'rule';
}

function clauseEntries(
  clauses: Clause[],
  sources: Map<string, MemorySource[]>,
  rawClauses: Clause[],
  rawSources: Map<string, MemorySource[]>
): Map<string, ClauseEntry> {
  const entries = new Map<string, ClauseEntry>();
  for (const clause of clauses) {
    const key = canonicalKey(clause);
    if (entries.has(key)) continue;
    entries.set(key, {
      clause,
      serialized: serializeClause(clause),
      kind: clauseKind(clause),
      sources: (sources.get(key) ?? []).map((source) => structuredClone(source)),
    });
  }
  for (const clause of rawClauses) {
    if (!isEntityMetadataDeclaration(clause) || isTentativeDeclaration(clause)) {
      continue;
    }
    const key = canonicalKey(clause);
    if (entries.has(key)) continue;
    entries.set(key, {
      clause,
      serialized: serializeClause(clause),
      kind: 'identity_metadata',
      sources: (rawSources.get(key) ?? []).map((source) => structuredClone(source)),
    });
  }
  return entries;
}

const kindOrder: Record<RecordedClauseKind, number> = {
  fact: 0,
  rule: 1,
  constraint: 2,
  identity_metadata: 3,
};

function compareClauseState(
  left: Pick<RecordedClauseState, 'kind' | 'clause'>,
  right: Pick<RecordedClauseState, 'kind' | 'clause'>
): number {
  return kindOrder[left.kind] - kindOrder[right.kind] || left.clause.localeCompare(right.clause);
}

function asClauseState(entry: ClauseEntry): RecordedClauseState {
  return {
    kind: entry.kind,
    clause: entry.serialized,
    sources: entry.sources,
  };
}

function clauseDelta(
  before: Map<string, ClauseEntry>,
  after: Map<string, ClauseEntry>
): RecordedClauseDelta {
  const added = [...after]
    .filter(([key]) => !before.has(key))
    .map(([, entry]) => asClauseState(entry))
    .sort(compareClauseState);
  const removed = [...before]
    .filter(([key]) => !after.has(key))
    .map(([, entry]) => asClauseState(entry))
    .sort(compareClauseState);
  const sourceChanged = [...after]
    .flatMap(([key, entry]): RecordedClauseSourceChange[] => {
      const prior = before.get(key);
      if (prior === undefined) return [];
      if (
        prior.serialized === entry.serialized &&
        JSON.stringify(prior.sources) === JSON.stringify(entry.sources)
      ) {
        return [];
      }
      return [
        {
          kind: entry.kind,
          beforeClause: prior.serialized,
          afterClause: entry.serialized,
          beforeSources: prior.sources,
          afterSources: entry.sources,
        },
      ];
    })
    .sort((left, right) =>
      compareClauseState(
        { kind: left.kind, clause: left.afterClause },
        { kind: right.kind, clause: right.afterClause }
      )
    );
  const total = added.length + removed.length + sourceChanged.length;
  if (total > MAX_RECORDED_DIFF_CHANGES) {
    throw new EngineLimitError(
      `recorded knowledge diff exceeded ${MAX_RECORDED_DIFF_CHANGES} clause changes`
    );
  }
  return { added, removed, sourceChanged };
}

function byId<T extends { id: string }>(values: T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function setAdded(values: string[], baseline: string[]): string[] {
  const prior = new Set(baseline);
  return values.filter((value) => !prior.has(value));
}

function topologyDelta(
  beforeClauses: Clause[],
  beforeSources: Map<string, MemorySource[]>,
  afterClauses: Clause[],
  afterSources: Map<string, MemorySource[]>,
  entityIdentity: EntityIdentityMode | undefined,
  trustMode: TrustViewMode
): RecordedTopologyDelta {
  const options = {
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  };
  const before = analyzeKnowledgeTopology(beforeClauses, beforeSources, options);
  const after = analyzeKnowledgeTopology(afterClauses, afterSources, options);
  const beforeNodes = byId(before.graph.nodes);
  const afterNodes = byId(after.graph.nodes);
  const beforeEdges = byId(before.graph.edges);
  const afterEdges = byId(after.graph.edges);
  const changedNodes = [...afterNodes]
    .flatMap(([id, node]): RecordedTopologyNodeChange[] => {
      const prior = beforeNodes.get(id);
      return prior !== undefined && JSON.stringify(prior) !== JSON.stringify(node)
        ? [{ before: prior, after: node }]
        : [];
    })
    .sort((left, right) => left.after.id.localeCompare(right.after.id));
  return {
    before: {
      predicateCount: before.predicateCount,
      factCount: before.factCount,
      ruleCount: before.ruleCount,
      constraintCount: before.constraintCount,
      edgeCount: before.edgeCount,
    },
    after: {
      predicateCount: after.predicateCount,
      factCount: after.factCount,
      ruleCount: after.ruleCount,
      constraintCount: after.constraintCount,
      edgeCount: after.edgeCount,
    },
    addedNodes: [...afterNodes]
      .filter(([id]) => !beforeNodes.has(id))
      .map(([, node]) => node),
    removedNodes: [...beforeNodes]
      .filter(([id]) => !afterNodes.has(id))
      .map(([, node]) => node),
    changedNodes,
    addedEdges: [...afterEdges]
      .filter(([id]) => !beforeEdges.has(id))
      .map(([, edge]) => edge),
    removedEdges: [...beforeEdges]
      .filter(([id]) => !afterEdges.has(id))
      .map(([, edge]) => edge),
    openInputsAdded: setAdded(after.openInputs, before.openInputs),
    openInputsRemoved: setAdded(before.openInputs, after.openInputs),
    openNegatedInputsAdded: setAdded(
      after.openNegatedInputs,
      before.openNegatedInputs
    ),
    openNegatedInputsRemoved: setAdded(
      before.openNegatedInputs,
      after.openNegatedInputs
    ),
    recursionAdded: after.recursiveComponents.filter(
      ({ id }) => !before.recursiveComponents.some((component) => component.id === id)
    ),
    recursionRemoved: before.recursiveComponents.filter(
      ({ id }) => !after.recursiveComponents.some((component) => component.id === id)
    ),
  };
}

function integrityViolations(
  result: IntegrityCheckResult
): Array<{ key: string; value: RecordedIntegrityViolationChange }> {
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
        row,
      },
    }))
  );
}

function integrityDelta(
  beforeClauses: Clause[],
  beforeSources: Map<string, MemorySource[]>,
  afterClauses: Clause[],
  afterSources: Map<string, MemorySource[]>,
  entityIdentity: EntityIdentityMode | undefined,
  trustMode: TrustViewMode,
  maxViolations: number | undefined,
  maxProofsPerRow: number | undefined
): RecordedIntegrityDelta {
  const options = {
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(maxViolations === undefined ? {} : { maxViolations }),
    ...(maxProofsPerRow === undefined ? {} : { maxProofsPerRow }),
  };
  const before = checkIntegrity(beforeClauses, beforeSources, options);
  const after = checkIntegrity(afterClauses, afterSources, options);
  const beforeViolations = integrityViolations(before);
  const afterViolations = integrityViolations(after);
  const beforeKeys = new Set(beforeViolations.map(({ key }) => key));
  const afterKeys = new Set(afterViolations.map(({ key }) => key));
  return {
    before,
    after,
    introduced: afterViolations
      .filter(({ key }) => !beforeKeys.has(key))
      .map(({ value }) => value),
    resolved: beforeViolations
      .filter(({ key }) => !afterKeys.has(key))
      .map(({ value }) => value),
  };
}

function rowKey(row: ExplainedKnowledgeRow): string {
  return JSON.stringify(Object.entries(row.bindings));
}

function queryImpact(
  query: string,
  beforeClauses: Clause[],
  beforeSources: Map<string, MemorySource[]>,
  afterClauses: Clause[],
  afterSources: Map<string, MemorySource[]>,
  entityIdentity: EntityIdentityMode | undefined,
  trustMode: TrustViewMode,
  maxProofsPerRow: number | undefined
): RecordedQueryImpact {
  const options = {
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(maxProofsPerRow === undefined ? {} : { maxProofsPerRow }),
  };
  const before = explainKnowledge(beforeClauses, query, beforeSources, options);
  const after = explainKnowledge(afterClauses, query, afterSources, options);
  const beforeRows = new Map(before.rows.map((row) => [rowKey(row), row]));
  const afterRows = new Map(after.rows.map((row) => [rowKey(row), row]));
  const evidenceChanged: RecordedQueryImpact['evidenceChanged'] = [];
  let unchangedCount = 0;
  for (const row of after.rows) {
    const prior = beforeRows.get(rowKey(row));
    if (prior === undefined) continue;
    if (JSON.stringify(prior) === JSON.stringify(row)) unchangedCount += 1;
    else evidenceChanged.push({ before: prior, after: row });
  }
  return {
    query,
    before,
    after,
    added: after.rows.filter((row) => !beforeRows.has(rowKey(row))),
    removed: before.rows.filter((row) => !afterRows.has(rowKey(row))),
    evidenceChanged,
    unchangedCount,
  };
}

function snapshotMetadata(
  snapshot: ReturnType<MemoryStore['recordedSnapshot']>
): RecordedSnapshotMetadata {
  return {
    sequence: snapshot.sequence,
    journalEntries: snapshot.journalEntries,
    namespaces: snapshot.namespaces,
  };
}

/** Compare two exact recorded knowledge states and every selected deterministic consequence. */
export function diffRecordedKnowledge(
  store: MemoryStore,
  fromSequence: number,
  toSequence: number,
  options: RecordedKnowledgeDiffOptions = {}
): RecordedKnowledgeDiffResult {
  if (
    !Number.isSafeInteger(fromSequence) ||
    !Number.isSafeInteger(toSequence) ||
    fromSequence < 0 ||
    toSequence < 0
  ) {
    throw new Error('recorded diff sequences must be non-negative safe integers');
  }
  if (fromSequence > toSequence) {
    throw new Error('recorded diff fromSequence must not exceed toSequence');
  }
  const namespaces = options.namespaces ?? ['default'];
  const [beforeSnapshot, afterSnapshot] = store.recordedSnapshots(
    namespaces,
    [fromSequence, toSequence]
  );
  const trustMode = options.trustMode ?? 'accepted';
  const beforeView = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(
        beforeSnapshot.clauses,
        beforeSnapshot.sources,
        trustMode
      )
    : literalKnowledge(
        beforeSnapshot.clauses,
        beforeSnapshot.sources,
        trustMode
      );
  const afterView = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(
        afterSnapshot.clauses,
        afterSnapshot.sources,
        trustMode
      )
    : literalKnowledge(
        afterSnapshot.clauses,
        afterSnapshot.sources,
        trustMode
      );
  const clauses = clauseDelta(
    clauseEntries(
      beforeView.clauses,
      beforeView.sources,
      beforeSnapshot.clauses,
      beforeSnapshot.sources
    ),
    clauseEntries(
      afterView.clauses,
      afterView.sources,
      afterSnapshot.clauses,
      afterSnapshot.sources
    )
  );
  const topology = topologyDelta(
    beforeSnapshot.clauses,
    beforeSnapshot.sources,
    afterSnapshot.clauses,
    afterSnapshot.sources,
    options.entityIdentity,
    trustMode
  );
  const integrity = integrityDelta(
    beforeSnapshot.clauses,
    beforeSnapshot.sources,
    afterSnapshot.clauses,
    afterSnapshot.sources,
    options.entityIdentity,
    trustMode,
    options.maxViolations,
    options.maxProofsPerRow
  );
  const impact = options.query === undefined
    ? undefined
    : queryImpact(
        options.query,
        beforeSnapshot.clauses,
        beforeSnapshot.sources,
        afterSnapshot.clauses,
        afterSnapshot.sources,
        options.entityIdentity,
        trustMode,
        options.maxProofsPerRow
      );
  const changed =
    clauses.added.length > 0 ||
    clauses.removed.length > 0 ||
    clauses.sourceChanged.length > 0;
  return {
    changed,
    from: snapshotMetadata(beforeSnapshot),
    to: snapshotMetadata(afterSnapshot),
    journalEntriesTraversed: toSequence - fromSequence,
    clauses,
    topology,
    integrity,
    ...(impact === undefined ? {} : { queryImpact: impact }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  };
}
