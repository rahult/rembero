import { EngineLimitError, type Clause } from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  browseKnowledgeGraph,
  knowledgeGraphEntityId,
  DEFAULT_BROWSE_GRAPH_CLAIMS,
  MAX_BROWSE_ENTITY_FOCUS_BYTES,
  MAX_BROWSE_GRAPH_CLAIMS,
  MAX_BROWSE_GRAPH_DEPTH,
} from './browse.js';
import type {
  EntityGraphNode,
  ExplanationGraph,
  ExplanationGraphEdge,
  ExplanationGraphNode,
} from './graph.js';
import {
  canonicalizeKnowledge,
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
}

export interface ConnectKnowledgeGraphResult {
  status: 'connected' | 'no_path';
  shortestHops: number | null;
  /** True for a connection, or when the complete reachable component was exhausted. */
  searchComplete: boolean;
  paths: KnowledgeGraphPath[];
  graph: ExplanationGraph;
  selection: ConnectKnowledgeGraphSelection;
  skippedNonGroundFacts: number;
  trustMode?: TrustViewMode;
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
  positions: ReadonlyMap<string, number>
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
    });
  }
  return { hops: segments.length, nodeIds, entities, segments };
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
  const resolver = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode).resolver
    : undefined;
  const resolvedFrom =
    typeof from === 'string' && resolver !== undefined ? resolver.resolve(from) : from;
  const resolvedTo =
    typeof to === 'string' && resolver !== undefined ? resolver.resolve(to) : to;
  const fromNodeId = knowledgeGraphEntityId(resolvedFrom);
  const toNodeId = knowledgeGraphEntityId(resolvedTo);
  const browsed = browseKnowledgeGraph(clauses, sourceIndex, {
    focus: from,
    depth: maxDepth,
    maxClaims,
    ...(options.entityIdentity === undefined
      ? {}
      : { entityIdentity: options.entityIdentity }),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
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
  const paths = nodePaths.map((nodeIds) => pathFor(nodeIds, nodes, positions));
  const selectedNodeIds = new Set(nodePaths.flat());
  const graphNodes: ExplanationGraphNode[] = paths.length === 0
    ? [endpointNode(resolvedFrom, resolver), endpointNode(resolvedTo, resolver)]
    : browsed.graph.nodes.filter((node) => selectedNodeIds.has(node.id));
  const graphEdges: ExplanationGraphEdge[] = paths.length === 0
    ? []
    : browsed.graph.edges.filter(
        (edge) => selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)
      );
  const graph: ExplanationGraph = {
    nodes: [...new Map(graphNodes.map((node) => [node.id, node])).values()].sort(
      (left, right) => left.id.localeCompare(right.id)
    ),
    edges: graphEdges.sort((left, right) => left.id.localeCompare(right.id)),
  };
  const connected = paths.length > 0;
  return {
    status: connected ? 'connected' : 'no_path',
    shortestHops: connected ? paths[0].hops : null,
    searchComplete: connected || browsed.selection.frontierExhausted,
    paths,
    graph,
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
    },
    skippedNonGroundFacts: browsed.skippedNonGroundFacts,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  };
}
