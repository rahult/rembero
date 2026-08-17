import { createHash } from 'node:crypto';
import {
  type EvaluateOptions,
  EngineLimitError,
  materialize,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
} from './identity.js';
import {
  analyzeKnowledgeTopology,
  type AnalyzeKnowledgeTopologyOptions,
  type KnowledgeTopologyEdge,
  type KnowledgeTopologyNode,
  type KnowledgeTopologyResult,
} from './topology.js';

export const MAX_RULE_AUDIT_FINDINGS = 4_096;

export type RuleAuditSeverity = 'warning' | 'info';
export type RuleAuditStatus = 'clean' | 'advisory' | 'review';
export type RuleAuditCode =
  | 'open_negated_input'
  | 'policy_open_input'
  | 'unseeded_recursion'
  | 'open_positive_input'
  | 'inactive_derived_predicate'
  | 'duplicate_semantic_rule'
  | 'predicate_arity_overload';

export interface RuleAuditFinding {
  id: string;
  severity: RuleAuditSeverity;
  code: RuleAuditCode;
  message: string;
  predicateKeys: string[];
  ruleIds: string[];
  constraintIds: string[];
  relatedNodeIds: string[];
  currentFactCount?: number;
  componentId?: string;
}

export interface RuleAuditFindingNode extends RuleAuditFinding {
  kind: 'finding';
}

export type RuleAuditGraphNode = KnowledgeTopologyNode | RuleAuditFindingNode;
export type RuleAuditGraphEdge =
  | KnowledgeTopologyEdge
  | {
      id: string;
      kind: 'flags';
      from: string;
      to: string;
    };

export interface RuleAuditGraph {
  nodes: RuleAuditGraphNode[];
  edges: RuleAuditGraphEdge[];
}

export interface AuditKnowledgeRulesOptions
  extends AnalyzeKnowledgeTopologyOptions,
    Pick<EvaluateOptions, 'maxFacts' | 'maxIterations' | 'relationIndex'> {}

export interface RuleAuditResult {
  status: RuleAuditStatus;
  warningCount: number;
  infoCount: number;
  findingCount: number;
  findings: RuleAuditFinding[];
  topology: KnowledgeTopologyResult;
  materializedFactCount: number;
  graph: RuleAuditGraph;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

const severityOrder: Record<RuleAuditSeverity, number> = {
  warning: 0,
  info: 1,
};

function relatedNodes(
  topology: KnowledgeTopologyResult,
  predicateKey: string
): {
  ruleIds: string[];
  constraintIds: string[];
  relatedNodeIds: string[];
} {
  const predicateNodeId = `predicate:${predicateKey}`;
  const incoming = topology.graph.edges.filter((edge) => edge.to === predicateNodeId);
  const ruleIds = incoming
    .map(({ from }) => from)
    .filter((id) => id.startsWith('rule:'))
    .sort();
  const constraintIds = incoming
    .map(({ from }) => from)
    .filter((id) => id.startsWith('constraint:'))
    .sort();
  return {
    ruleIds: [...new Set(ruleIds)],
    constraintIds: [...new Set(constraintIds)],
    relatedNodeIds: [predicateNodeId, ...new Set([...ruleIds, ...constraintIds])].sort(),
  };
}

function finding(
  severity: RuleAuditSeverity,
  code: RuleAuditCode,
  message: string,
  predicateKeys: string[],
  ruleIds: string[],
  constraintIds: string[],
  relatedNodeIds: string[],
  extra: Pick<RuleAuditFinding, 'currentFactCount' | 'componentId'> = {}
): RuleAuditFinding {
  const identity = [code, predicateKeys, ruleIds, constraintIds, extra];
  return {
    id: stableId('finding', identity),
    severity,
    code,
    message,
    predicateKeys: [...predicateKeys].sort(),
    ruleIds: [...ruleIds].sort(),
    constraintIds: [...constraintIds].sort(),
    relatedNodeIds: [...new Set(relatedNodeIds)].sort(),
    ...(extra.currentFactCount === undefined
      ? {}
      : { currentFactCount: extra.currentFactCount }),
    ...(extra.componentId === undefined ? {} : { componentId: extra.componentId }),
  };
}

function graphFor(
  topology: KnowledgeTopologyResult,
  findings: RuleAuditFinding[]
): RuleAuditGraph {
  const findingNodes: RuleAuditFindingNode[] = findings.map((value) => ({
    ...value,
    kind: 'finding',
  }));
  const flags = findings.flatMap((value) =>
    value.relatedNodeIds.map((nodeId) => ({
      id: stableId('rule-audit-edge', ['flags', value.id, nodeId]),
      kind: 'flags' as const,
      from: value.id,
      to: nodeId,
    }))
  );
  return {
    nodes: [...topology.graph.nodes, ...findingNodes].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    edges: [...topology.graph.edges, ...flags].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  };
}

/** Audit deterministic rule structure and current productivity without inventing policy. */
export function auditKnowledgeRules(
  clauses: Parameters<typeof analyzeKnowledgeTopology>[0],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: AuditKnowledgeRulesOptions = {}
): RuleAuditResult {
  const {
    maxFacts,
    maxIterations,
    relationIndex,
    entityIdentity,
    trustMode,
    focus,
    direction,
  } = options;
  const topology = analyzeKnowledgeTopology(clauses, sourceIndex, {
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(trustMode === undefined ? {} : { trustMode }),
    ...(focus === undefined ? {} : { focus }),
    ...(direction === undefined ? {} : { direction }),
  });
  const view = entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode)
    : literalKnowledge(clauses, sourceIndex, trustMode);
  const materialized = materialize(view.clauses, {
    ...(maxFacts === undefined ? {} : { maxFacts }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(relationIndex === undefined ? {} : { relationIndex }),
  });
  const materializedByPredicate = new Map<string, number>();
  for (const fact of materialized) {
    const key = `${fact.predicate}/${fact.values.length}`;
    materializedByPredicate.set(key, (materializedByPredicate.get(key) ?? 0) + 1);
  }
  const selectedPredicateKeys = new Set(
    topology.predicates.map(({ key }) => key)
  );
  const selectedMaterializedFactCount = [...materializedByPredicate]
    .filter(([key]) => selectedPredicateKeys.has(key))
    .reduce((total, [, count]) => total + count, 0);

  const findings: RuleAuditFinding[] = [];
  const add = (value: RuleAuditFinding) => {
    findings.push(value);
    if (findings.length > MAX_RULE_AUDIT_FINDINGS) {
      throw new EngineLimitError(
        `rule audit exceeded ${MAX_RULE_AUDIT_FINDINGS} findings`
      );
    }
  };

  for (const predicate of topology.predicates) {
    if (predicate.openInput && predicate.negativeReferences > 0) {
      const related = relatedNodes(topology, predicate.key);
      add(
        finding(
          'warning',
          'open_negated_input',
          `${predicate.key} has no fact or rule definition but is used under closed-world negation; every grounded absence check currently succeeds.`,
          [predicate.key],
          related.ruleIds,
          related.constraintIds,
          related.relatedNodeIds,
          { currentFactCount: 0 }
        )
      );
    }
    if (predicate.openInput && predicate.constraintReferences > 0) {
      const related = relatedNodes(topology, predicate.key);
      add(
        finding(
          'warning',
          'policy_open_input',
          `${predicate.key} has no definition but participates in ${predicate.constraintReferences} integrity-policy goal(s).`,
          [predicate.key],
          related.ruleIds,
          related.constraintIds,
          related.relatedNodeIds,
          { currentFactCount: 0 }
        )
      );
    }
    if (
      predicate.openInput &&
      predicate.positiveReferences > 0 &&
      predicate.negativeReferences === 0
    ) {
      const related = relatedNodes(topology, predicate.key);
      add(
        finding(
          'info',
          'open_positive_input',
          `${predicate.key} is required by a rule or policy but has no selected fact or rule definition.`,
          [predicate.key],
          related.ruleIds,
          related.constraintIds,
          related.relatedNodeIds,
          { currentFactCount: 0 }
        )
      );
    }
    const currentFactCount = materializedByPredicate.get(predicate.key) ?? 0;
    if (predicate.derivedOnly && !predicate.recursive && currentFactCount === 0) {
      const related = relatedNodes(topology, predicate.key);
      add(
        finding(
          'info',
          'inactive_derived_predicate',
          `${predicate.key} is rule-defined but materializes no facts in the selected current view.`,
          [predicate.key],
          related.ruleIds,
          related.constraintIds,
          related.relatedNodeIds,
          { currentFactCount }
        )
      );
    }
  }

  for (const component of topology.recursiveComponents) {
    const currentFactCount = component.predicates.reduce(
      (total, key) => total + (materializedByPredicate.get(key) ?? 0),
      0
    );
    if (currentFactCount > 0) continue;
    const predicateIds = component.predicates.map((key) => `predicate:${key}`);
    const ruleIds = topology.rules
      .filter((rule) => rule.numbers.some((number) => component.ruleNumbers.includes(number)))
      .map(({ id }) => id);
    add(
      finding(
        'warning',
        'unseeded_recursion',
        `Recursive component ${component.predicates.join(', ')} materializes no facts in the selected view.`,
        component.predicates,
        ruleIds,
        [],
        [...predicateIds, ...ruleIds],
        { currentFactCount, componentId: component.id }
      )
    );
  }

  for (const rule of topology.rules) {
    if (rule.numbers.length < 2) continue;
    add(
      finding(
        'info',
        'duplicate_semantic_rule',
        `Alpha-equivalent rule is authored at engine positions ${rule.numbers.join(', ')}.`,
        [],
        [rule.id],
        [],
        [rule.id]
      )
    );
  }

  const byName = new Map<string, typeof topology.predicates>();
  for (const predicate of topology.predicates) {
    const values = byName.get(predicate.predicate) ?? [];
    values.push(predicate);
    byName.set(predicate.predicate, values);
  }
  for (const [name, predicates] of byName) {
    if (predicates.length < 2) continue;
    const keys = predicates.map(({ key }) => key).sort();
    add(
      finding(
        'info',
        'predicate_arity_overload',
        `${name} appears at multiple arities: ${keys.join(', ')}.`,
        keys,
        [],
        [],
        predicates.map(({ id }) => id)
      )
    );
  }

  findings.sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.code.localeCompare(right.code) ||
      left.id.localeCompare(right.id)
  );
  const warningCount = findings.filter(({ severity }) => severity === 'warning').length;
  const infoCount = findings.length - warningCount;
  return {
    status: warningCount > 0 ? 'review' : infoCount > 0 ? 'advisory' : 'clean',
    warningCount,
    infoCount,
    findingCount: findings.length,
    findings,
    topology,
    materializedFactCount: selectedMaterializedFactCount,
    graph: graphFor(topology, findings),
  };
}
