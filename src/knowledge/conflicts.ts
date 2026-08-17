import { createHash } from 'node:crypto';
import {
  EngineSafetyError,
  parseProgram,
  serializeTerm,
  type Term,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  type ConflictGraphNode,
  type ExplainedKnowledgeRow,
  type ExplanationGraph,
  type ExplanationGraphEdge,
  type ExplanationGraphNode,
  type ExplanationRule,
} from './graph.js';
import {
  selectExplanationGraph,
  type ExplanationGraphSelection,
  type ExplanationGraphSelector,
} from './graph-navigation.js';
import {
  canonicalizeKnowledge,
  type EntityIdentityMode,
  type EntityRewrite,
} from './identity.js';
import {
  checkIntegrity,
  type IntegrityCheckOptions,
  type IntegrityStatus,
} from './integrity.js';
import type { TrustViewMode } from './trust.js';

export const MAX_CONFLICT_FOCUS_BYTES = 4_096;

type ConflictFocusTerm =
  | Extract<Term, { type: 'atom' }>
  | Extract<Term, { type: 'num' }>;

export interface ConflictConstraint {
  id: string;
  clause: string;
  query: string;
  sources?: MemorySource[];
  projectedFrom?: string;
  identityRewrites?: EntityRewrite[];
}

export interface ConflictViolation extends ExplainedKnowledgeRow {
  constraintId: string;
  constraintClause: string;
  /** One-based row number in the underlying integrity check. */
  constraintRow: number;
  /** Cluster-local result node ID; distinct even when two policies bind identically. */
  graphResultId: string;
  /** First alpha-stable variable in the authored constraint, absent for global policy. */
  focusBinding?: string;
}

export interface ConflictCluster {
  id: string;
  /** Serialized ground Datalog value, or null for a variable-free global constraint. */
  focus: string | null;
  violationCount: number;
  constraintIds: string[];
  constraints: ConflictConstraint[];
  rows: ConflictViolation[];
  rules: ExplanationRule[];
  graph: ExplanationGraph;
  graphSelection?: ExplanationGraphSelection;
}

export interface ConflictViewOptions extends IntegrityCheckOptions {
  /** Optional ground Datalog atom or number used to return one focus cluster. */
  focus?: string;
  /** Optional deterministic graph projection applied to every returned cluster. */
  graphSelector?: ExplanationGraphSelector;
}

export interface ConflictViewResult {
  status: IntegrityStatus;
  constraintCount: number;
  /** Complete violations in the selected knowledge view, before an optional focus filter. */
  violationCount: number;
  /** Normalized requested focus, when supplied. */
  focus?: string;
  matchingViolationCount: number;
  clusterCount: number;
  clusters: ConflictCluster[];
  trustMode?: TrustViewMode;
}

interface ConflictClusterBuilder {
  id: string;
  focus: string | null;
  rows: ConflictViolation[];
  constraints: Map<string, ConflictConstraint>;
  rules: Map<string, ExplanationRule>;
  nodes: Map<string, ExplanationGraphNode>;
  edges: Map<string, ExplanationGraphEdge>;
}

function clusterId(focus: string | null): string {
  return `conflict:${createHash('sha256')
    .update(JSON.stringify(focus === null ? ['global'] : ['focus', focus]))
    .digest('hex')}`;
}

function baseResultId(bindings: Record<string, string>): string {
  return `result:${JSON.stringify(Object.entries(bindings))}`;
}

function conflictResultId(
  cluster: string,
  constraint: string,
  row: number,
  bindings: Record<string, string>
): string {
  return `result:conflict:${createHash('sha256')
    .update(JSON.stringify([cluster, constraint, row, Object.entries(bindings)]))
    .digest('hex')}`;
}

function graphEdgeId(edge: Omit<ExplanationGraphEdge, 'id'>): string {
  return `edge:${JSON.stringify([
    edge.kind,
    edge.from,
    edge.to,
    edge.position ?? null,
    edge.alternative ?? null,
  ])}`;
}

function renameResultNode(
  graph: ExplanationGraph,
  previousId: string,
  replacementId: string
): ExplanationGraph {
  return {
    nodes: graph.nodes.map((node) =>
      node.id === previousId ? { ...node, id: replacementId } : node
    ),
    edges: graph.edges.map((edge) => {
      if (edge.from !== previousId && edge.to !== previousId) return edge;
      const renamed = {
        ...edge,
        from: edge.from === previousId ? replacementId : edge.from,
        to: edge.to === previousId ? replacementId : edge.to,
      };
      return { ...renamed, id: graphEdgeId(renamed) };
    }),
  };
}

function conflictEdge(
  cluster: string,
  result: string,
  position: number
): ExplanationGraphEdge {
  return {
    id: `edge:${JSON.stringify(['contains', cluster, result, position, null])}`,
    kind: 'contains',
    from: cluster,
    to: result,
    position,
  };
}

function parseFocus(value: string): ConflictFocusTerm {
  if (Buffer.byteLength(value, 'utf8') > MAX_CONFLICT_FOCUS_BYTES) {
    throw new EngineSafetyError(
      `conflict focus exceeds ${MAX_CONFLICT_FOCUS_BYTES} bytes`
    );
  }
  try {
    const clauses = parseProgram(`rembero_conflict_focus(${value}).`);
    const term = clauses[0]?.head.args[0];
    if (
      clauses.length !== 1 ||
      clauses[0].head.predicate !== 'rembero_conflict_focus' ||
      clauses[0].head.args.length !== 1 ||
      clauses[0].body.length !== 0 ||
      (term?.type !== 'atom' && term?.type !== 'num')
    ) {
      throw new Error('invalid focus');
    }
    return term as ConflictFocusTerm;
  } catch {
    throw new EngineSafetyError(
      'conflict focus must be exactly one ground Datalog atom or number'
    );
  }
}

function normalizedFocus(
  requested: string | undefined,
  entityIdentity: EntityIdentityMode | undefined,
  clauses: Parameters<typeof canonicalizeKnowledge>[0],
  sources: Map<string, MemorySource[]>
): string | undefined {
  if (requested === undefined) return undefined;
  const term = parseFocus(requested);
  if (term.type === 'num' || entityIdentity !== 'canonical') return serializeTerm(term);
  const resolver = canonicalizeKnowledge(clauses, sources).resolver;
  return serializeTerm({ type: 'atom', value: resolver.resolve(term.value) });
}

function mergeGraph(builder: ConflictClusterBuilder, graph: ExplanationGraph): void {
  for (const node of graph.nodes) builder.nodes.set(node.id, node);
  for (const edge of graph.edges) builder.edges.set(edge.id, edge);
}

/**
 * Group complete integrity evidence by each constraint's first alpha-stable binding.
 * The projection is read-only and deliberately follows authored variable order instead
 * of guessing which predicate argument represents a subject.
 */
export function inspectConflicts(
  clauses: Parameters<typeof checkIntegrity>[0],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: ConflictViewOptions = {}
): ConflictViewResult {
  const { focus: requestedFocus, graphSelector, ...integrityOptions } = options;
  const entityIdentity = integrityOptions.entityIdentity;
  const trustMode = integrityOptions.trustMode;
  const focus = normalizedFocus(
    requestedFocus,
    entityIdentity,
    clauses,
    sourceIndex
  );
  const audit = checkIntegrity(clauses, sourceIndex, integrityOptions);
  const builders = new Map<string, ConflictClusterBuilder>();

  for (const check of audit.checks) {
    for (const [rowIndex, row] of check.rows.entries()) {
      const focusBinding = check.bindingOrder[0];
      const rowFocus = focusBinding === undefined ? null : row.bindings[focusBinding];
      if (focusBinding !== undefined && rowFocus === undefined) {
        throw new EngineSafetyError(
          `constraint '${check.id}' did not bind its declared conflict focus`
        );
      }
      if (focus !== undefined && rowFocus !== focus) continue;
      const id = clusterId(rowFocus);
      let builder = builders.get(id);
      if (builder === undefined) {
        builder = {
          id,
          focus: rowFocus,
          rows: [],
          constraints: new Map(),
          rules: new Map(),
          nodes: new Map(),
          edges: new Map(),
        };
        builders.set(id, builder);
      }

      const constraintRow = rowIndex + 1;
      const graphResultId = conflictResultId(
        id,
        check.id,
        constraintRow,
        row.bindings
      );
      builder.rows.push({
        constraintId: check.id,
        constraintClause: check.clause,
        constraintRow,
        graphResultId,
        ...(focusBinding === undefined ? {} : { focusBinding }),
        ...row,
      });
      builder.constraints.set(check.id, {
        id: check.id,
        clause: check.clause,
        query: check.query,
        ...(check.sources === undefined ? {} : { sources: check.sources }),
        ...(check.projectedFrom === undefined
          ? {}
          : { projectedFrom: check.projectedFrom }),
        ...(check.identityRewrites === undefined
          ? {}
          : { identityRewrites: check.identityRewrites }),
      });
      for (const rule of check.rules) {
        builder.rules.set(JSON.stringify([rule.number, rule.clause]), rule);
      }
      const support = selectExplanationGraph(check, {
        kind: 'result',
        row: constraintRow,
      });
      mergeGraph(
        builder,
        renameResultNode(
          support.graph,
          baseResultId(row.bindings),
          graphResultId
        )
      );
    }
  }

  const clusters = [...builders.values()].map((builder): ConflictCluster => {
    const constraintIds = [...builder.constraints.keys()];
    const conflictNode: ConflictGraphNode = {
      id: builder.id,
      kind: 'conflict',
      focus: builder.focus,
      violationCount: builder.rows.length,
      constraintIds,
    };
    builder.nodes.set(conflictNode.id, conflictNode);
    for (const [position, row] of builder.rows.entries()) {
      const edge = conflictEdge(builder.id, row.graphResultId, position);
      builder.edges.set(edge.id, edge);
    }
    const cluster: ConflictCluster = {
      id: builder.id,
      focus: builder.focus,
      violationCount: builder.rows.length,
      constraintIds,
      constraints: [...builder.constraints.values()],
      rows: builder.rows,
      rules: [...builder.rules.values()].sort(
        (left, right) => left.number - right.number || left.clause.localeCompare(right.clause)
      ),
      graph: {
        nodes: [...builder.nodes.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
        edges: [...builder.edges.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
      },
    };
    return graphSelector === undefined
      ? cluster
      : selectExplanationGraph(cluster, graphSelector);
  });

  return {
    status: audit.status,
    constraintCount: audit.constraintCount,
    violationCount: audit.violationCount,
    ...(focus === undefined ? {} : { focus }),
    matchingViolationCount: clusters.reduce(
      (total, cluster) => total + cluster.violationCount,
      0
    ),
    clusterCount: clusters.length,
    clusters,
    ...(trustMode === undefined || trustMode === 'accepted' ? {} : { trustMode }),
  };
}
