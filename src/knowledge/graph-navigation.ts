import { EngineSafetyError } from '../engine/index.js';
import type {
  ExplainKnowledgeResult,
  ExplanationGraph,
  ExplanationGraphEdge,
  ExplanationGraphNode,
} from './graph.js';

export const MAX_GRAPH_NEIGHBOR_DEPTH = 8;
export const MAX_GRAPH_NODE_ID_BYTES = 4_096;
export const MAX_GRAPH_RESULT_ROW = 10_000;

export type ExplanationGraphSelector =
  | { kind: 'result'; row: number }
  | { kind: 'support'; nodeId: string }
  | { kind: 'neighbors'; nodeId: string; depth?: number };

export interface ExplanationGraphSelection {
  selector: ExplanationGraphSelector;
  focusNodeIds: string[];
  originalNodeCount: number;
  originalEdgeCount: number;
}

export interface GraphSelectableExplanation {
  rows: Array<{
    bindings: Record<string, string>;
    /** Optional explanation-local result node ID for composite projections. */
    graphResultId?: string;
  }>;
  graph: ExplanationGraph;
  graphSelection?: ExplanationGraphSelection;
}

function resultId(row: GraphSelectableExplanation['rows'][number]): string {
  return row.graphResultId ?? `result:${JSON.stringify(Object.entries(row.bindings))}`;
}

function assertNodeId(nodeId: string): void {
  if (nodeId.length === 0) throw new EngineSafetyError('graph node id must not be empty');
  if (Buffer.byteLength(nodeId, 'utf8') > MAX_GRAPH_NODE_ID_BYTES) {
    throw new EngineSafetyError(
      `graph node id exceeds ${MAX_GRAPH_NODE_ID_BYTES} bytes`
    );
  }
}

function validateSelector(selector: ExplanationGraphSelector): ExplanationGraphSelector {
  if (selector.kind === 'result') {
    if (
      !Number.isSafeInteger(selector.row) ||
      selector.row < 1 ||
      selector.row > MAX_GRAPH_RESULT_ROW
    ) {
      throw new EngineSafetyError(
        `graph result row must be from 1 to ${MAX_GRAPH_RESULT_ROW}`
      );
    }
    return { kind: 'result', row: selector.row };
  }
  assertNodeId(selector.nodeId);
  if (selector.kind === 'support') {
    return { kind: 'support', nodeId: selector.nodeId };
  }
  const depth = selector.depth ?? 1;
  if (
    !Number.isSafeInteger(depth) ||
    depth < 1 ||
    depth > MAX_GRAPH_NEIGHBOR_DEPTH
  ) {
    throw new EngineSafetyError(
      `graph neighbor depth must be from 1 to ${MAX_GRAPH_NEIGHBOR_DEPTH}`
    );
  }
  return { kind: 'neighbors', nodeId: selector.nodeId, depth };
}

function requireNode(
  nodes: ReadonlyMap<string, ExplanationGraphNode>,
  nodeId: string
): void {
  if (!nodes.has(nodeId)) {
    throw new EngineSafetyError(`graph node '${nodeId}' is not present in this explanation`);
  }
}

function supportClosure(
  graph: ExplanationGraph,
  nodes: ReadonlyMap<string, ExplanationGraphNode>,
  focusNodeIds: string[]
): Set<string> {
  const outgoing = new Map<string, ExplanationGraphEdge[]>();
  const proving = new Map<string, ExplanationGraphEdge[]>();
  for (const edge of graph.edges) {
    const bySource = outgoing.get(edge.from) ?? [];
    bySource.push(edge);
    outgoing.set(edge.from, bySource);
    if (edge.kind === 'proves') {
      const byClaim = proving.get(edge.to) ?? [];
      byClaim.push(edge);
      proving.set(edge.to, byClaim);
    }
  }

  const selected = new Set(focusNodeIds);
  const queue = [...focusNodeIds];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const node = nodes.get(current);
    const candidates = [
      ...(outgoing.get(current) ?? []),
      ...(node?.kind === 'claim' ? (proving.get(current) ?? []) : []),
    ];
    for (const edge of candidates) {
      const adjacent = edge.from === current ? edge.to : edge.from;
      if (selected.has(adjacent)) continue;
      selected.add(adjacent);
      queue.push(adjacent);
    }
  }
  return selected;
}

function neighborClosure(
  graph: ExplanationGraph,
  focusNodeId: string,
  depth: number
): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = adjacent.get(edge.from) ?? [];
    from.push(edge.to);
    adjacent.set(edge.from, from);
    const to = adjacent.get(edge.to) ?? [];
    to.push(edge.from);
    adjacent.set(edge.to, to);
  }

  const selected = new Set([focusNodeId]);
  let frontier = [focusNodeId];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const candidate of adjacent.get(current) ?? []) {
        if (selected.has(candidate)) continue;
        selected.add(candidate);
        next.push(candidate);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return selected;
}

function inducedGraph(graph: ExplanationGraph, selected: ReadonlySet<string>): ExplanationGraph {
  return {
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter(
      (edge) => selected.has(edge.from) && selected.has(edge.to)
    ),
  };
}

/**
 * Deterministically select a complete subgraph from an already-bounded explanation.
 * The operation is pure: rows, rules, proofs, and the source graph are not mutated.
 */
export function selectExplanationGraph<T extends GraphSelectableExplanation>(
  explanation: T,
  requestedSelector: ExplanationGraphSelector
): T & { graphSelection: ExplanationGraphSelection } {
  const selector = validateSelector(requestedSelector);
  const nodes = new Map(explanation.graph.nodes.map((node) => [node.id, node]));
  let focusNodeIds: string[];
  let selected: Set<string>;

  if (selector.kind === 'result') {
    const row = explanation.rows[selector.row - 1];
    focusNodeIds = row === undefined ? [] : [resultId(row)];
    for (const nodeId of focusNodeIds) requireNode(nodes, nodeId);
    selected = supportClosure(explanation.graph, nodes, focusNodeIds);
  } else if (selector.kind === 'support') {
    requireNode(nodes, selector.nodeId);
    focusNodeIds = [selector.nodeId];
    selected = supportClosure(explanation.graph, nodes, focusNodeIds);
  } else {
    requireNode(nodes, selector.nodeId);
    focusNodeIds = [selector.nodeId];
    selected = neighborClosure(explanation.graph, selector.nodeId, selector.depth ?? 1);
  }

  return {
    ...explanation,
    graph: inducedGraph(explanation.graph, selected),
    graphSelection: {
      selector,
      focusNodeIds,
      originalNodeCount: explanation.graph.nodes.length,
      originalEdgeCount: explanation.graph.edges.length,
    },
  };
}

export function selectKnowledgeGraph(
  explanation: ExplainKnowledgeResult,
  selector: ExplanationGraphSelector
): ExplainKnowledgeResult & { graphSelection: ExplanationGraphSelection } {
  return selectExplanationGraph(explanation, selector);
}
