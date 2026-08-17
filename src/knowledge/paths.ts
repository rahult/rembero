import {
  EngineLimitError,
  materialize,
  serializeTerm,
  type Clause,
  type Term,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  browseKnowledgeGraph,
  knowledgeGraphClaimId,
  knowledgeGraphEntityId,
  DEFAULT_BROWSE_GRAPH_CLAIMS,
  MAX_BROWSE_ENTITY_FOCUS_BYTES,
  MAX_BROWSE_GRAPH_CLAIMS,
  MAX_BROWSE_GRAPH_DEPTH,
  MAX_BROWSE_GRAPH_FACTS,
} from './browse.js';
import {
  explainKnowledge,
  type ExplanationRule,
  EntityGraphNode,
  ExplanationGraph,
  ExplanationGraphEdge,
  ExplanationGraphNode,
  type SourcedDerivationProof,
  type SourcedProofStep,
} from './graph.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityIdentityMode,
  type EntityResolver,
} from './identity.js';
import type { TrustViewMode } from './trust.js';

export const DEFAULT_KNOWLEDGE_PATH_DEPTH = 4;
export const MAX_KNOWLEDGE_PATH_DEPTH = MAX_BROWSE_GRAPH_DEPTH;
export const DEFAULT_KNOWLEDGE_PATHS = 3;
export const MAX_KNOWLEDGE_PATHS = 16;

export interface ConnectKnowledgeGraphOptions {
  maxDepth?: number;
  maxPaths?: number;
  maxClaims?: number;
  /** Opt in to rule-derived materialized facts, each returned with a proof. */
  includeDerived?: boolean;
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
}

export interface KnowledgeGraphPathSegment {
  claimId: string;
  predicate: string;
  fromEntityId: string;
  toEntityId: string;
  from: string | number;
  to: string | number;
  fromPosition: number;
  toPosition: number;
  derived: boolean;
  rule?: number;
}

export interface KnowledgeGraphPath {
  hops: number;
  nodeIds: string[];
  entities: (string | number)[];
  segments: KnowledgeGraphPathSegment[];
}

export interface ConnectKnowledgeGraphSelection {
  from: string | number;
  resolvedFrom: string | number;
  fromNodeId: string;
  to: string | number;
  resolvedTo: string | number;
  toNodeId: string;
  maxDepth: number;
  maxPaths: number;
  maxClaims: number;
  totalGroundFacts: number;
  exploredClaims: number;
  exploredEntities: number;
  frontierExhausted: boolean;
  includeDerived: boolean;
  materializedDerivedFacts: number;
}

export interface KnowledgePathClaimProof {
  claimId: string;
  derived: boolean;
  proof: SourcedDerivationProof;
}

export interface ConnectKnowledgeGraphResult {
  status: 'connected' | 'no_path';
  shortestHops: number | null;
  /** True for a connection, or when the complete reachable component was exhausted. */
  searchComplete: boolean;
  paths: KnowledgeGraphPath[];
  graph: ExplanationGraph;
  /** Present only when rule-derived traversal was requested. */
  claimProofs?: KnowledgePathClaimProof[];
  /** Rule numbering used by the claim proofs. */
  rules?: ExplanationRule[];
  selection: ConnectKnowledgeGraphSelection;
  skippedNonGroundFacts: number;
  trustMode?: TrustViewMode;
  includeDerived?: true;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be from 1 to ${maximum}`);
  }
  return resolved;
}

function assertEndpoint(value: string | number, label: string): void {
  if (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') > MAX_BROWSE_ENTITY_FOCUS_BYTES
  ) {
    throw new Error(
      `knowledge graph ${label} exceeds ${MAX_BROWSE_ENTITY_FOCUS_BYTES} bytes`
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`knowledge graph numeric ${label} must be finite`);
  }
}

function endpointNode(
  value: string | number,
  resolver: EntityResolver | undefined
): EntityGraphNode {
  const aliases = typeof value === 'string' ? resolver?.aliasesFor(value) : undefined;
  return {
    id: knowledgeGraphEntityId(value),
    kind: 'entity',
    value,
    valueType: typeof value === 'number' ? 'number' : 'atom',
    ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
  };
}

function addNeighbor(
  adjacency: Map<string, Set<string>>,
  left: string,
  right: string
): void {
  const neighbors = adjacency.get(left) ?? new Set<string>();
  neighbors.add(right);
  adjacency.set(left, neighbors);
}

function shortestNodePaths(
  graph: ExplanationGraph,
  fromNodeId: string,
  toNodeId: string,
  maxPaths: number
): string[][] {
  if (fromNodeId === toNodeId) return [[fromNodeId]];
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'arg') continue;
    addNeighbor(adjacency, edge.from, edge.to);
    addNeighbor(adjacency, edge.to, edge.from);
  }
  const distance = new Map<string, number>([[fromNodeId, 0]]);
  const predecessors = new Map<string, Set<string>>();
  const queue = [fromNodeId];
  let targetDistance: number | undefined;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const currentDistance = distance.get(current)!;
    if (targetDistance !== undefined && currentDistance >= targetDistance) continue;
    for (const next of [...(adjacency.get(current) ?? [])].sort()) {
      const nextDistance = currentDistance + 1;
      const knownDistance = distance.get(next);
      if (knownDistance === undefined) {
        distance.set(next, nextDistance);
        predecessors.set(next, new Set([current]));
        queue.push(next);
        if (next === toNodeId) targetDistance = nextDistance;
      } else if (knownDistance === nextDistance) {
        predecessors.get(next)!.add(current);
      }
    }
  }
  if (!distance.has(toNodeId)) return [];

  const paths: string[][] = [];
  const collect = (nodeId: string, suffix: string[]) => {
    if (nodeId === fromNodeId) {
      paths.push([fromNodeId, ...suffix]);
      if (paths.length > maxPaths) {
        throw new EngineLimitError(
          `knowledge graph connection exceeded ${maxPaths} shortest paths`
        );
      }
      return;
    }
    for (const predecessor of [...(predecessors.get(nodeId) ?? [])].sort()) {
      collect(predecessor, [nodeId, ...suffix]);
    }
  };
  collect(toNodeId, []);
  return paths.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function pathFor(
  nodeIds: string[],
  nodes: ReadonlyMap<string, ExplanationGraphNode>,
  positions: ReadonlyMap<string, number>,
  derivedClaims: ReadonlyMap<string, boolean>,
  claimRules: ReadonlyMap<string, number>
): KnowledgeGraphPath {
  const entities: (string | number)[] = [];
  const segments: KnowledgeGraphPathSegment[] = [];
  for (let index = 0; index < nodeIds.length; index += 2) {
    const entity = nodes.get(nodeIds[index]);
    if (entity?.kind !== 'entity') {
      throw new Error('knowledge graph path did not alternate entity and claim nodes');
    }
    entities.push(entity.value);
    if (index + 2 >= nodeIds.length) continue;
    const claim = nodes.get(nodeIds[index + 1]);
    const target = nodes.get(nodeIds[index + 2]);
    if (claim?.kind !== 'claim' || target?.kind !== 'entity') {
      throw new Error('knowledge graph path did not alternate entity and claim nodes');
    }
    const fromPosition = positions.get(`${claim.id}\0${entity.id}`);
    const toPosition = positions.get(`${claim.id}\0${target.id}`);
    if (fromPosition === undefined || toPosition === undefined) {
      throw new Error('knowledge graph path is missing an argument position');
    }
    segments.push({
      claimId: claim.id,
      predicate: claim.predicate,
      fromEntityId: entity.id,
      toEntityId: target.id,
      from: entity.value,
      to: target.value,
      fromPosition,
      toPosition,
      derived: derivedClaims.get(claim.id) ?? false,
      ...(claimRules.get(claim.id) === undefined
        ? {}
        : { rule: claimRules.get(claim.id) }),
    });
  }
  return { hops: segments.length, nodeIds, entities, segments };
}

function termFor(value: string | number): Term {
  return typeof value === 'number'
    ? { type: 'num', value }
    : { type: 'atom', value };
}

function factClause(predicate: string, values: (string | number)[]): Clause {
  return {
    head: { predicate, args: values.map(termFor) },
    body: [],
  };
}

function groundQuery(predicate: string, values: (string | number)[]): string {
  return values.length === 0
    ? predicate
    : `${predicate}(${values.map((value) => serializeTerm(termFor(value))).join(', ')})`;
}

function mergeProofGraph(
  graph: ExplanationGraph,
  nodes: Map<string, ExplanationGraphNode>,
  edges: Map<string, ExplanationGraphEdge>
): void {
  const inputTargets = new Set(
    graph.edges.filter((edge) => edge.kind === 'input').map((edge) => edge.to)
  );
  const topResults = new Set(
    graph.nodes
      .filter((node) => node.kind === 'result' && !inputTargets.has(node.id))
      .map((node) => node.id)
  );
  for (const node of graph.nodes) {
    if (!topResults.has(node.id)) nodes.set(node.id, node);
  }
  for (const edge of graph.edges) {
    if (!topResults.has(edge.from) && !topResults.has(edge.to)) {
      edges.set(edge.id, edge);
    }
  }
}

function collectProofRules(
  proof: SourcedProofStep,
  rules: Set<number>
): void {
  if ('negated' in proof) return;
  if (proof.rule !== undefined) rules.add(proof.rule);
  for (const child of proof.because ?? []) collectProofRules(child, rules);
  for (const contributor of proof.aggregate?.contributors ?? []) {
    for (const child of contributor.proofs) collectProofRules(child, rules);
  }
}

/** Find every bounded shortest path between two entities over explicit ground facts. */
export function connectKnowledgeGraph(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  from: string | number,
  to: string | number,
  options: ConnectKnowledgeGraphOptions = {}
): ConnectKnowledgeGraphResult {
  assertEndpoint(from, 'path start');
  assertEndpoint(to, 'path end');
  const maxDepth = boundedInteger(
    options.maxDepth,
    DEFAULT_KNOWLEDGE_PATH_DEPTH,
    MAX_KNOWLEDGE_PATH_DEPTH,
    'knowledge graph path depth'
  );
  const maxPaths = boundedInteger(
    options.maxPaths,
    DEFAULT_KNOWLEDGE_PATHS,
    MAX_KNOWLEDGE_PATHS,
    'knowledge graph path limit'
  );
  const maxClaims = boundedInteger(
    options.maxClaims,
    DEFAULT_BROWSE_GRAPH_CLAIMS,
    MAX_BROWSE_GRAPH_CLAIMS,
    'knowledge graph claim limit'
  );
  const trustMode = options.trustMode ?? 'accepted';
  const knowledgeView = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode)
    : literalKnowledge(clauses, sourceIndex, trustMode);
  const resolver = options.entityIdentity === 'canonical'
    ? knowledgeView.resolver
    : undefined;
  const resolvedFrom =
    typeof from === 'string' && resolver !== undefined ? resolver.resolve(from) : from;
  const resolvedTo =
    typeof to === 'string' && resolver !== undefined ? resolver.resolve(to) : to;
  const fromNodeId = knowledgeGraphEntityId(resolvedFrom);
  const toNodeId = knowledgeGraphEntityId(resolvedTo);
  let traversalClauses = clauses;
  let traversalSources = sourceIndex;
  let traversalFocus = from;
  const derivedClaims = new Map<string, boolean>();
  let materializedDerivedFacts = 0;
  if (options.includeDerived === true) {
    const facts = materialize(knowledgeView.clauses, {
      maxFacts: MAX_BROWSE_GRAPH_FACTS,
    });
    traversalClauses = facts.map((fact) => factClause(fact.predicate, fact.values));
    traversalSources = knowledgeView.sources;
    traversalFocus = resolvedFrom;
    for (const fact of facts) {
      const id = knowledgeGraphClaimId(fact.predicate, fact.values);
      derivedClaims.set(id, fact.derived);
      if (fact.derived) materializedDerivedFacts++;
    }
  }
  const browsed = browseKnowledgeGraph(traversalClauses, traversalSources, {
    focus: traversalFocus,
    depth: maxDepth,
    maxClaims,
    ...(options.includeDerived === true || options.entityIdentity === undefined
      ? {}
      : { entityIdentity: options.entityIdentity }),
    ...(options.includeDerived === true || trustMode === 'accepted'
      ? {}
      : { trustMode }),
  });
  const nodes = new Map(browsed.graph.nodes.map((node) => [node.id, node]));
  const positions = new Map<string, number>();
  for (const edge of browsed.graph.edges) {
    if (edge.kind !== 'arg' || edge.position === undefined) continue;
    const key = `${edge.from}\0${edge.to}`;
    const current = positions.get(key);
    if (current === undefined || edge.position < current) {
      positions.set(key, edge.position);
    }
  }
  const nodePaths = shortestNodePaths(
    browsed.graph,
    fromNodeId,
    toNodeId,
    maxPaths
  );
  const selectedNodeIds = new Set(nodePaths.flat());
  const selectedClaimIds = [...new Set(
    nodePaths.flatMap((nodeIds) =>
      nodeIds.filter((_nodeId, index) => index % 2 === 1)
    )
  )].sort();
  const claimProofs: KnowledgePathClaimProof[] = [];
  const claimRules = new Map<string, number>();
  const ruleCatalog = new Map<number, ExplanationRule>();
  const usedRuleNumbers = new Set<number>();
  const proofNodes = new Map<string, ExplanationGraphNode>();
  const proofEdges = new Map<string, ExplanationGraphEdge>();
  if (options.includeDerived === true) {
    for (const claimId of selectedClaimIds) {
      const claim = nodes.get(claimId);
      if (claim?.kind !== 'claim') {
        throw new Error('knowledge graph path claim is missing from traversal graph');
      }
      const explained = explainKnowledge(
        clauses,
        groundQuery(claim.predicate, claim.values),
        sourceIndex,
        {
          ...(options.entityIdentity === undefined
            ? {}
            : { entityIdentity: options.entityIdentity }),
          ...(trustMode === 'accepted' ? {} : { trustMode }),
        }
      );
      const proof = explained.rows[0]?.proofs[0];
      if (proof === undefined || 'aggregated' in proof || 'negated' in proof) {
        throw new Error('materialized path claim did not produce a derivation proof');
      }
      claimProofs.push({
        claimId,
        derived: derivedClaims.get(claimId) ?? false,
        proof,
      });
      if (proof.rule !== undefined) claimRules.set(claimId, proof.rule);
      for (const rule of explained.rules) ruleCatalog.set(rule.number, rule);
      collectProofRules(proof, usedRuleNumbers);
      mergeProofGraph(explained.graph, proofNodes, proofEdges);
    }
  }
  const paths = nodePaths.map((nodeIds) =>
    pathFor(nodeIds, nodes, positions, derivedClaims, claimRules)
  );
  const graphNodes: ExplanationGraphNode[] = paths.length === 0
    ? [endpointNode(resolvedFrom, resolver), endpointNode(resolvedTo, resolver)]
    : browsed.graph.nodes.filter((node) => selectedNodeIds.has(node.id));
  const graphEdges: ExplanationGraphEdge[] = paths.length === 0
    ? []
    : browsed.graph.edges.filter(
        (edge) => selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)
      );
  const graph: ExplanationGraph = {
    nodes: [...new Map([
      ...graphNodes.map((node) => [node.id, node] as const),
      ...proofNodes.entries(),
    ]).values()].sort(
      (left, right) => left.id.localeCompare(right.id)
    ),
    edges: [...new Map([
      ...graphEdges.map((edge) => [edge.id, edge] as const),
      ...proofEdges.entries(),
    ]).values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const connected = paths.length > 0;
  return {
    status: connected ? 'connected' : 'no_path',
    shortestHops: connected ? paths[0].hops : null,
    searchComplete: connected || browsed.selection.frontierExhausted,
    paths,
    graph,
    ...(options.includeDerived === true
      ? {
          claimProofs,
          rules: [...usedRuleNumbers]
            .sort((left, right) => left - right)
            .map((number) => ruleCatalog.get(number)!)
            .filter((rule) => rule !== undefined),
        }
      : {}),
    selection: {
      from,
      resolvedFrom,
      fromNodeId,
      to,
      resolvedTo,
      toNodeId,
      maxDepth,
      maxPaths,
      maxClaims,
      totalGroundFacts: browsed.selection.totalGroundFacts,
      exploredClaims: browsed.selection.selectedClaims,
      exploredEntities: browsed.selection.selectedEntities,
      frontierExhausted: browsed.selection.frontierExhausted,
      includeDerived: options.includeDerived === true,
      materializedDerivedFacts,
    },
    skippedNonGroundFacts: browsed.skippedNonGroundFacts,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
    ...(options.includeDerived === true ? { includeDerived: true as const } : {}),
  };
}
