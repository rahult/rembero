import {
  type Bindings,
  type Clause,
  type DerivationProof,
  type Term,
  canonicalKey,
  evaluateWithProof,
  parseQuery,
  serializeClause,
  serializeTerm,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';

export interface SourcedDerivationProof extends Omit<DerivationProof, 'because'> {
  because?: SourcedDerivationProof[];
  sources?: MemorySource[];
}

export interface ExplainedKnowledgeRow {
  bindings: Record<string, string>;
  proofs: SourcedDerivationProof[];
}

export interface ExplanationRule {
  number: number;
  clause: string;
}

export interface ResultGraphNode {
  id: string;
  kind: 'result';
  bindings: Record<string, string>;
}

export interface ClaimGraphNode {
  id: string;
  kind: 'claim';
  predicate: string;
  values: (string | number)[];
  derived: boolean;
  rule?: number;
  sources?: MemorySource[];
}

export interface EntityGraphNode {
  id: string;
  kind: 'entity';
  value: string | number;
  valueType: 'atom' | 'number';
}

export type ExplanationGraphNode = ResultGraphNode | ClaimGraphNode | EntityGraphNode;

export interface ExplanationGraphEdge {
  id: string;
  kind: 'answers' | 'because' | 'arg';
  from: string;
  to: string;
  position?: number;
}

export interface ExplanationGraph {
  nodes: ExplanationGraphNode[];
  edges: ExplanationGraphEdge[];
}

export interface ExplainKnowledgeResult {
  rows: ExplainedKnowledgeRow[];
  rules: ExplanationRule[];
  graph: ExplanationGraph;
}

function proofClauseKey(proof: DerivationProof): string {
  const args: Term[] = proof.values.map((value) =>
    typeof value === 'number'
      ? { type: 'num', value }
      : { type: 'atom', value }
  );
  return canonicalKey({ head: { predicate: proof.predicate, args }, body: [] });
}

function addSources(
  proof: DerivationProof,
  sourceIndex: Map<string, MemorySource[]>
): SourcedDerivationProof {
  const sources = proof.rule === undefined ? sourceIndex.get(proofClauseKey(proof)) : undefined;
  const witnessSources = sources?.slice(0, 1);
  return {
    predicate: proof.predicate,
    values: proof.values,
    ...(proof.rule === undefined ? {} : { rule: proof.rule }),
    ...(proof.because === undefined
      ? {}
      : { because: proof.because.map((child) => addSources(child, sourceIndex)) }),
    ...(witnessSources === undefined || witnessSources.length === 0
      ? {}
      : { sources: witnessSources }),
  };
}

function bindingStrings(bindings: Bindings): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, term]) => [name, serializeTerm(term)])
  );
}

function typedValue(value: string | number): ['atom' | 'number', string | number] {
  return [typeof value === 'number' ? 'number' : 'atom', value];
}

function entityId(value: string | number): string {
  return `entity:${JSON.stringify(typedValue(value))}`;
}

function claimId(proof: SourcedDerivationProof): string {
  return `claim:${JSON.stringify([
    proof.predicate,
    proof.values.map((value) => typedValue(value)),
  ])}`;
}

function resultId(bindings: Record<string, string>): string {
  return `result:${JSON.stringify(Object.entries(bindings))}`;
}

function edge(
  kind: ExplanationGraphEdge['kind'],
  from: string,
  to: string,
  position?: number
): ExplanationGraphEdge {
  return {
    id: `edge:${JSON.stringify([kind, from, to, position ?? null])}`,
    kind,
    from,
    to,
    ...(position === undefined ? {} : { position }),
  };
}

export function buildExplanationGraph(rows: ExplainedKnowledgeRow[]): ExplanationGraph {
  const nodes = new Map<string, ExplanationGraphNode>();
  const edges = new Map<string, ExplanationGraphEdge>();

  const addEdge = (value: ExplanationGraphEdge) => edges.set(value.id, value);
  const addProof = (proof: SourcedDerivationProof): string => {
    const id = claimId(proof);
    nodes.set(id, {
      id,
      kind: 'claim',
      predicate: proof.predicate,
      values: proof.values,
      derived: proof.rule !== undefined,
      ...(proof.rule === undefined ? {} : { rule: proof.rule }),
      ...(proof.sources === undefined ? {} : { sources: proof.sources }),
    });
    for (const [position, value] of proof.values.entries()) {
      const target = entityId(value);
      nodes.set(target, {
        id: target,
        kind: 'entity',
        value,
        valueType: typeof value === 'number' ? 'number' : 'atom',
      });
      addEdge(edge('arg', id, target, position));
    }
    for (const [position, child] of (proof.because ?? []).entries()) {
      const target = addProof(child);
      addEdge(edge('because', id, target, position));
    }
    return id;
  };

  for (const row of rows) {
    const id = resultId(row.bindings);
    nodes.set(id, { id, kind: 'result', bindings: row.bindings });
    for (const [position, proof] of row.proofs.entries()) {
      addEdge(edge('answers', id, addProof(proof), position));
    }
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function explainKnowledge(
  clauses: Clause[],
  query: string,
  sourceIndex: Map<string, MemorySource[]> = new Map()
): ExplainKnowledgeResult {
  const explained = evaluateWithProof(clauses, parseQuery(query));
  const rows = explained.map(({ bindings, proofs }) => ({
    bindings: bindingStrings(bindings),
    proofs: proofs.map((proof) => addSources(proof, sourceIndex)),
  }));
  return {
    rows,
    rules: clauses
      .filter((clause) => clause.body.length > 0)
      .map((clause, index) => ({ number: index + 1, clause: serializeClause(clause) })),
    graph: buildExplanationGraph(rows),
  };
}
