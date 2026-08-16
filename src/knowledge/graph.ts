import { createHash } from 'node:crypto';
import {
  type AbsenceProof,
  type AggregateProof,
  type Bindings,
  type Clause,
  type DerivationProof,
  type EvaluateOptions,
  type ProofStep,
  type QueryProof,
  type Term,
  canonicalKey,
  evaluateQuerySpecWithProof,
  parseQuerySpec,
  serializeClause,
  serializeTerm,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';

export interface SourcedDerivationProof extends Omit<DerivationProof, 'because'> {
  because?: SourcedProofStep[];
  sources?: MemorySource[];
}

export type SourcedAbsenceProof = AbsenceProof;
export type SourcedProofStep = SourcedDerivationProof | SourcedAbsenceProof;

export interface SourcedAggregateProof extends Omit<AggregateProof, 'contributors'> {
  contributors: Array<{
    bindings: Record<string, string>;
    proofs: SourcedProofStep[];
  }>;
}

export type SourcedQueryProof = SourcedProofStep | SourcedAggregateProof;

export interface ExplainedKnowledgeRow {
  bindings: Record<string, string>;
  proofs: SourcedQueryProof[];
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

export interface AbsenceGraphNode {
  id: string;
  kind: 'absence';
  predicate: string;
  pattern: (string | number | null)[];
  stratum: number;
}

export interface AggregateGraphNode {
  id: string;
  kind: 'aggregate';
  op: AggregateProof['op'];
  input: '*' | string;
  as: string;
  value: string | number;
  contributorCount: number;
}

export type ExplanationGraphNode =
  | ResultGraphNode
  | ClaimGraphNode
  | EntityGraphNode
  | AbsenceGraphNode
  | AggregateGraphNode;

export interface ExplanationGraphEdge {
  id: string;
  kind: 'answers' | 'because' | 'arg' | 'input' | 'witness';
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

function isAbsenceProof(proof: ProofStep | SourcedProofStep): proof is AbsenceProof {
  return 'negated' in proof;
}

function isAggregateProof(
  proof: QueryProof | SourcedQueryProof
): proof is AggregateProof | SourcedAggregateProof {
  return 'aggregated' in proof;
}

function addSources(
  proof: ProofStep,
  sourceIndex: Map<string, MemorySource[]>
): SourcedProofStep {
  if (isAbsenceProof(proof)) return { ...proof, pattern: [...proof.pattern] };
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

function addQuerySources(
  proof: QueryProof,
  sourceIndex: Map<string, MemorySource[]>
): SourcedQueryProof {
  if (!isAggregateProof(proof)) return addSources(proof, sourceIndex);
  return {
    aggregated: true,
    op: proof.op,
    input: proof.input,
    as: proof.as,
    value: proof.value,
    contributors: proof.contributors.map((contributor) => ({
      bindings: bindingStrings(contributor.bindings),
      proofs: contributor.proofs.map((child) => addSources(child, sourceIndex)),
    })),
    ...(proof.witnessPositions === undefined
      ? {}
      : { witnessPositions: [...proof.witnessPositions] }),
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

function absenceId(proof: SourcedAbsenceProof): string {
  return `absence:${JSON.stringify([
    proof.predicate,
    proof.pattern.map((value) =>
      value === null ? ['wildcard'] : typedValue(value)
    ),
    proof.stratum,
  ])}`;
}

function aggregateId(proof: SourcedAggregateProof): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([proof.op, proof.input, proof.as, typedValue(proof.value)]));
  for (const contributor of proof.contributors) {
    hash.update(JSON.stringify(Object.entries(contributor.bindings)));
    hash.update(
      JSON.stringify(
        contributor.proofs.map((child) =>
          isAbsenceProof(child) ? absenceId(child) : claimId(child)
        )
      )
    );
  }
  return `aggregate:${proof.op}:${hash.digest('hex')}`;
}

function resultId(bindings: Record<string, string>): string {
  return `result:${JSON.stringify(Object.entries(bindings))}`;
}

function contributorResultId(
  aggregate: string,
  position: number,
  bindings: Record<string, string>
): string {
  return `result:input:${JSON.stringify([aggregate, position, Object.entries(bindings)])}`;
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
  const addProof = (proof: SourcedProofStep): string => {
    if (isAbsenceProof(proof)) {
      const id = absenceId(proof);
      nodes.set(id, {
        id,
        kind: 'absence',
        predicate: proof.predicate,
        pattern: proof.pattern,
        stratum: proof.stratum,
      });
      for (const [position, value] of proof.pattern.entries()) {
        if (value === null) continue;
        const target = entityId(value);
        nodes.set(target, {
          id: target,
          kind: 'entity',
          value,
          valueType: typeof value === 'number' ? 'number' : 'atom',
        });
        addEdge(edge('arg', id, target, position));
      }
      return id;
    }
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

  const addAggregate = (proof: SourcedAggregateProof): string => {
    const id = aggregateId(proof);
    nodes.set(id, {
      id,
      kind: 'aggregate',
      op: proof.op,
      input: proof.input,
      as: proof.as,
      value: proof.value,
      contributorCount: proof.contributors.length,
    });
    const witnesses = new Set(proof.witnessPositions ?? []);
    for (const [position, contributor] of proof.contributors.entries()) {
      const contributorId = contributorResultId(id, position, contributor.bindings);
      nodes.set(contributorId, {
        id: contributorId,
        kind: 'result',
        bindings: contributor.bindings,
      });
      for (const [proofPosition, child] of contributor.proofs.entries()) {
        addEdge(edge('answers', contributorId, addProof(child), proofPosition));
      }
      addEdge(edge('input', id, contributorId, position));
      if (witnesses.has(position)) {
        addEdge(edge('witness', id, contributorId, position));
      }
    }
    return id;
  };

  for (const row of rows) {
    const id = resultId(row.bindings);
    nodes.set(id, { id, kind: 'result', bindings: row.bindings });
    for (const [position, proof] of row.proofs.entries()) {
      addEdge(
        edge(
          'answers',
          id,
          isAggregateProof(proof) ? addAggregate(proof) : addProof(proof),
          position
        )
      );
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
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: EvaluateOptions = {}
): ExplainKnowledgeResult {
  const explained = evaluateQuerySpecWithProof(clauses, parseQuerySpec(query), options);
  const rows = explained.map(({ bindings, proofs }) => ({
    bindings: bindingStrings(bindings),
    proofs: proofs.map((proof) => addQuerySources(proof, sourceIndex)),
  }));
  return {
    rows,
    rules: clauses
      .filter((clause) => clause.body.length > 0)
      .map((clause, index) => ({ number: index + 1, clause: serializeClause(clause) })),
    graph: buildExplanationGraph(rows),
  };
}
