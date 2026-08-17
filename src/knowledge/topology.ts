import { createHash } from 'node:crypto';
import {
  type Clause,
  canonicalKey,
  isAggregateRule,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  predKey,
  serializeClause,
  stratifyProgram,
  EngineLimitError,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityIdentityMode,
} from './identity.js';
import type { TrustViewMode } from './trust.js';

export const MAX_TOPOLOGY_FACTS = 100_000;
export const MAX_TOPOLOGY_PREDICATES = 4_096;
export const MAX_TOPOLOGY_RULES = 4_096;
export const MAX_TOPOLOGY_CONSTRAINTS = 256;
export const MAX_TOPOLOGY_EDGES = 32_768;
export const MAX_TOPOLOGY_FOCUS_BYTES = 256;

export type TopologyDirection = 'upstream' | 'downstream' | 'both';

export interface PredicateTopologyNode {
  id: string;
  kind: 'predicate';
  key: string;
  predicate: string;
  arity: number;
  stratum: number;
  factCount: number;
  ruleCount: number;
  authoredRuleCount: number;
  positiveReferences: number;
  negativeReferences: number;
  aggregateReferences: number;
  constraintReferences: number;
  openInput: boolean;
  derivedOnly: boolean;
  recursive: boolean;
  definitionNamespaces: string[];
  definitionOperationCount: number;
}

export interface RuleTopologyNode {
  id: string;
  kind: 'rule';
  numbers: number[];
  clause: string;
  aggregate: boolean;
  comparisonCount: number;
  sources?: MemorySource[];
}

export interface ConstraintTopologyNode {
  id: string;
  kind: 'constraint';
  clause: string;
  comparisonCount: number;
  sources?: MemorySource[];
}

export type KnowledgeTopologyNode =
  | PredicateTopologyNode
  | RuleTopologyNode
  | ConstraintTopologyNode;

export interface KnowledgeTopologyEdge {
  id: string;
  kind: 'defines' | 'requires' | 'excludes';
  from: string;
  to: string;
  position?: number;
  aggregate?: true;
}

export interface KnowledgeTopologyGraph {
  nodes: KnowledgeTopologyNode[];
  edges: KnowledgeTopologyEdge[];
}

export interface RecursivePredicateComponent {
  id: string;
  predicates: string[];
  ruleNumbers: number[];
}

export interface KnowledgeTopologySelection {
  focus: string;
  direction: TopologyDirection;
  originalPredicateCount: number;
  originalRuleCount: number;
  originalConstraintCount: number;
  originalNodeCount: number;
  originalEdgeCount: number;
}

export interface AnalyzeKnowledgeTopologyOptions {
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
  focus?: string;
  direction?: TopologyDirection;
}

export interface KnowledgeTopologyResult {
  predicateCount: number;
  factCount: number;
  ruleCount: number;
  authoredRuleCount: number;
  constraintCount: number;
  edgeCount: number;
  predicates: PredicateTopologyNode[];
  rules: RuleTopologyNode[];
  constraints: ConstraintTopologyNode[];
  strata: Array<{ stratum: number; predicates: string[] }>;
  recursiveComponents: RecursivePredicateComponent[];
  openInputs: string[];
  openNegatedInputs: string[];
  graph: KnowledgeTopologyGraph;
  selection?: KnowledgeTopologySelection;
  trustMode?: TrustViewMode;
}

interface RuleGroup {
  clause: Clause;
  key: string;
  numbers: number[];
}

interface ConstraintGroup {
  clause: Clause;
  key: string;
}

interface PredicateAccumulator {
  predicate: string;
  arity: number;
  factKeys: Set<string>;
  ruleIds: Set<string>;
  authoredRules: number;
  positiveReferences: number;
  negativeReferences: number;
  aggregateReferences: number;
  constraintReferences: number;
  sourceNamespaces: Set<string>;
  sourceOperations: Set<string>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function predicateId(key: string): string {
  return `predicate:${key}`;
}

function ruleId(key: string): string {
  return `rule:${digest(key)}`;
}

function constraintId(key: string): string {
  return `constraint:${digest(key)}`;
}

function edgeId(
  kind: KnowledgeTopologyEdge['kind'],
  from: string,
  to: string,
  position: number | undefined,
  aggregate: boolean
): string {
  return `topology-edge:${digest(JSON.stringify([kind, from, to, position, aggregate]))}`;
}

function predicateParts(key: string): { predicate: string; arity: number } {
  const slash = key.lastIndexOf('/');
  return {
    predicate: key.slice(0, slash),
    arity: Number(key.slice(slash + 1)),
  };
}

function sourceCopies(
  sources: Map<string, MemorySource[]>,
  key: string
): MemorySource[] | undefined {
  const values = sources.get(key);
  return values === undefined || values.length === 0
    ? undefined
    : values.map((source) => structuredClone(source));
}

function assertTopologyLimit(value: number, maximum: number, label: string): void {
  if (value > maximum) {
    throw new EngineLimitError(`knowledge topology exceeded ${maximum} ${label}`);
  }
}

function recursiveComponents(
  predicateKeys: string[],
  adjacency: Map<string, Set<string>>,
  rules: RuleGroup[]
): RecursivePredicateComponent[] {
  const orderedKeys = [...predicateKeys].sort();
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const start of orderedKeys) {
    if (visited.has(start)) continue;
    const pending: Array<{ node: string; expanded: boolean }> = [
      { node: start, expanded: false },
    ];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.expanded) {
        finished.push(current.node);
        continue;
      }
      if (visited.has(current.node)) continue;
      visited.add(current.node);
      pending.push({ node: current.node, expanded: true });
      const dependencies = [...(adjacency.get(current.node) ?? [])].sort().reverse();
      for (const dependency of dependencies) {
        if (!visited.has(dependency)) {
          pending.push({ node: dependency, expanded: false });
        }
      }
    }
  }

  const reverse = new Map<string, Set<string>>();
  for (const key of orderedKeys) reverse.set(key, new Set());
  for (const [head, dependencies] of adjacency) {
    for (const dependency of dependencies) {
      const incoming = reverse.get(dependency) ?? new Set<string>();
      incoming.add(head);
      reverse.set(dependency, incoming);
    }
  }
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const start of [...finished].reverse()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const pending = [start];
    assigned.add(start);
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      const incoming = [...(reverse.get(current) ?? [])].sort().reverse();
      for (const dependency of incoming) {
        if (assigned.has(dependency)) continue;
        assigned.add(dependency);
        pending.push(dependency);
      }
    }
    component.sort();
    const selfRecursive =
      component.length === 1 && adjacency.get(component[0])?.has(component[0]);
    if (component.length > 1 || selfRecursive) components.push(component);
  }
  return components
    .map((predicates) => {
      const componentSet = new Set(predicates);
      const ruleNumbers = rules
        .filter((rule) => {
          const head = predKey(rule.clause.head);
          if (!componentSet.has(head)) return false;
          return rule.clause.body.some((goal) => {
            if (isComparison(goal)) return false;
            const literal = isNegation(goal) ? goal.not : goal;
            return componentSet.has(predKey(literal));
          });
        })
        .flatMap((rule) => rule.numbers)
        .sort((left, right) => left - right);
      return {
        id: `recursive:${digest(JSON.stringify(predicates))}`,
        predicates,
        ruleNumbers,
      };
    })
    .sort((left, right) => left.predicates[0].localeCompare(right.predicates[0]));
}

function resolveFocus(
  focus: string,
  predicates: PredicateTopologyNode[]
): string {
  if (Buffer.byteLength(focus, 'utf8') > MAX_TOPOLOGY_FOCUS_BYTES) {
    throw new Error(`topology focus exceeds ${MAX_TOPOLOGY_FOCUS_BYTES} bytes`);
  }
  const trimmed = focus.trim();
  const explicit = trimmed.match(/^([a-z][a-zA-Z0-9_]*)\/(\d+)$/);
  if (explicit !== null) {
    const arity = Number(explicit[2]);
    if (!Number.isSafeInteger(arity)) throw new Error('topology focus arity is invalid');
    const key = `${explicit[1]}/${arity}`;
    if (!predicates.some((predicate) => predicate.key === key)) {
      throw new Error(`topology focus '${key}' is not present`);
    }
    return key;
  }
  if (!/^[a-z][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("topology focus must be 'predicate' or 'predicate/arity'");
  }
  const matches = predicates.filter((predicate) => predicate.predicate === trimmed);
  if (matches.length === 0) throw new Error(`topology focus '${trimmed}' is not present`);
  if (matches.length > 1) {
    throw new Error(
      `topology focus '${trimmed}' is ambiguous: ${matches.map(({ key }) => key).join(', ')}`
    );
  }
  return matches[0].key;
}

function selectTopology(
  result: KnowledgeTopologyResult,
  focus: string,
  direction: TopologyDirection
): KnowledgeTopologyResult {
  const nodes = new Map(result.graph.nodes.map((node) => [node.id, node]));
  const definingRules = new Map<string, string[]>();
  const consumingRules = new Map<string, string[]>();
  const policyConsumers = new Map<string, string[]>();
  const edgesBySource = new Map<string, KnowledgeTopologyEdge[]>();
  for (const edge of result.graph.edges) {
    const outgoing = edgesBySource.get(edge.from) ?? [];
    outgoing.push(edge);
    edgesBySource.set(edge.from, outgoing);
    const source = nodes.get(edge.from);
    if (edge.kind === 'defines') {
      const values = definingRules.get(edge.to) ?? [];
      values.push(edge.from);
      definingRules.set(edge.to, values);
    } else if (source?.kind === 'constraint') {
      const values = policyConsumers.get(edge.to) ?? [];
      values.push(edge.from);
      policyConsumers.set(edge.to, values);
    } else {
      const values = consumingRules.get(edge.to) ?? [];
      values.push(edge.from);
      consumingRules.set(edge.to, values);
    }
  }

  const selected = new Set<string>();
  const includeRule = (id: string) => {
    selected.add(id);
    for (const edge of edgesBySource.get(id) ?? []) selected.add(edge.to);
  };
  const walkUpstream = (start: string) => {
    const visited = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const predicateNodeId = pending.pop()!;
      if (visited.has(predicateNodeId)) continue;
      visited.add(predicateNodeId);
      selected.add(predicateNodeId);
      for (const rule of definingRules.get(predicateNodeId) ?? []) {
        includeRule(rule);
        for (const edge of edgesBySource.get(rule) ?? []) {
          if (edge.kind !== 'defines') pending.push(edge.to);
        }
      }
    }
  };
  const walkDownstream = (start: string) => {
    const visited = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const predicateNodeId = pending.pop()!;
      if (visited.has(predicateNodeId)) continue;
      visited.add(predicateNodeId);
      selected.add(predicateNodeId);
      for (const rule of consumingRules.get(predicateNodeId) ?? []) {
        includeRule(rule);
        for (const edge of edgesBySource.get(rule) ?? []) {
          if (edge.kind === 'defines') pending.push(edge.to);
        }
      }
    }
  };

  const focusId = predicateId(focus);
  if (direction === 'upstream' || direction === 'both') walkUpstream(focusId);
  if (direction === 'downstream' || direction === 'both') walkDownstream(focusId);
  for (const nodeId of [...selected]) {
    const node = nodes.get(nodeId);
    if (node?.kind !== 'predicate') continue;
    for (const policy of policyConsumers.get(nodeId) ?? []) includeRule(policy);
  }
  const edges = result.graph.edges.filter(
    (edge) => selected.has(edge.from) && selected.has(edge.to)
  );
  const predicateNodes = result.predicates.filter((node) => selected.has(node.id));
  const ruleNodes = result.rules.filter((node) => selected.has(node.id));
  const constraintNodes = result.constraints.filter((node) => selected.has(node.id));
  const predicateKeys = new Set(predicateNodes.map(({ key }) => key));
  const graphNodes = [...predicateNodes, ...ruleNodes, ...constraintNodes].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return {
    predicateCount: predicateNodes.length,
    factCount: predicateNodes.reduce((total, node) => total + node.factCount, 0),
    ruleCount: ruleNodes.length,
    authoredRuleCount: ruleNodes.reduce(
      (total, node) => total + node.numbers.length,
      0
    ),
    constraintCount: constraintNodes.length,
    edgeCount: edges.length,
    predicates: predicateNodes,
    rules: ruleNodes,
    constraints: constraintNodes,
    strata: result.strata
      .map((stratum) => ({
        stratum: stratum.stratum,
        predicates: stratum.predicates.filter((key) => predicateKeys.has(key)),
      }))
      .filter((stratum) => stratum.predicates.length > 0),
    recursiveComponents: result.recursiveComponents.filter((component) =>
      component.predicates.some((key) => predicateKeys.has(key))
    ),
    openInputs: result.openInputs.filter((key) => predicateKeys.has(key)),
    openNegatedInputs: result.openNegatedInputs.filter((key) => predicateKeys.has(key)),
    graph: { nodes: graphNodes, edges },
    selection: {
      focus,
      direction,
      originalPredicateCount: result.predicateCount,
      originalRuleCount: result.ruleCount,
      originalConstraintCount: result.constraintCount,
      originalNodeCount: result.graph.nodes.length,
      originalEdgeCount: result.graph.edges.length,
    },
    ...(result.trustMode === undefined ? {} : { trustMode: result.trustMode }),
  };
}

/** Build a deterministic semantic graph of facts, rules, policies, and dependencies. */
export function analyzeKnowledgeTopology(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: AnalyzeKnowledgeTopologyOptions = {}
): KnowledgeTopologyResult {
  const { entityIdentity, trustMode, focus, direction } = options;
  if (direction !== undefined && focus === undefined) {
    throw new Error('topology direction requires a focus predicate');
  }
  if (
    direction !== undefined &&
    direction !== 'upstream' &&
    direction !== 'downstream' &&
    direction !== 'both'
  ) {
    throw new Error("topology direction must be 'upstream', 'downstream', or 'both'");
  }
  const view = entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode)
    : literalKnowledge(clauses, sourceIndex, trustMode);
  const facts = new Map<string, Clause>();
  const ruleGroups = new Map<string, RuleGroup>();
  const constraintGroups = new Map<string, ConstraintGroup>();
  let authoredRuleNumber = 0;
  for (const clause of view.clauses) {
    const key = canonicalKey(clause);
    if (isIntegrityConstraint(clause)) {
      if (!constraintGroups.has(key)) constraintGroups.set(key, { clause, key });
      assertTopologyLimit(
        constraintGroups.size,
        MAX_TOPOLOGY_CONSTRAINTS,
        'constraints'
      );
    } else if (clause.body.length === 0) {
      if (!facts.has(key)) facts.set(key, clause);
      assertTopologyLimit(facts.size, MAX_TOPOLOGY_FACTS, 'facts');
    } else {
      authoredRuleNumber += 1;
      assertTopologyLimit(authoredRuleNumber, MAX_TOPOLOGY_RULES, 'authored rules');
      const existing = ruleGroups.get(key);
      if (existing === undefined) {
        ruleGroups.set(key, { clause, key, numbers: [authoredRuleNumber] });
      } else {
        existing.numbers.push(authoredRuleNumber);
      }
      assertTopologyLimit(ruleGroups.size, MAX_TOPOLOGY_RULES, 'rules');
    }
  }
  const rules = [...ruleGroups.values()].sort(
    (left, right) => left.numbers[0] - right.numbers[0]
  );
  const constraints = [...constraintGroups.values()].sort((left, right) =>
    serializeClause(left.clause).localeCompare(serializeClause(right.clause))
  );
  const accumulators = new Map<string, PredicateAccumulator>();
  const accumulator = (key: string): PredicateAccumulator => {
    let value = accumulators.get(key);
    if (value !== undefined) return value;
    const parts = predicateParts(key);
    value = {
      ...parts,
      factKeys: new Set(),
      ruleIds: new Set(),
      authoredRules: 0,
      positiveReferences: 0,
      negativeReferences: 0,
      aggregateReferences: 0,
      constraintReferences: 0,
      sourceNamespaces: new Set(),
      sourceOperations: new Set(),
    };
    accumulators.set(key, value);
    assertTopologyLimit(accumulators.size, MAX_TOPOLOGY_PREDICATES, 'predicates');
    return value;
  };
  const addDefinitionSources = (target: PredicateAccumulator, clauseKey: string) => {
    for (const source of view.sources.get(clauseKey) ?? []) {
      target.sourceNamespaces.add(source.namespace);
      target.sourceOperations.add(`${source.namespace}\0${source.opId}`);
    }
  };

  for (const [key, clause] of facts) {
    const target = accumulator(predKey(clause.head));
    target.factKeys.add(key);
    addDefinitionSources(target, key);
  }
  for (const group of rules) {
    const target = accumulator(predKey(group.clause.head));
    target.ruleIds.add(ruleId(group.key));
    target.authoredRules += group.numbers.length;
    addDefinitionSources(target, group.key);
    for (const goal of group.clause.body) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      const dependency = accumulator(predKey(literal));
      if (isNegation(goal)) dependency.negativeReferences += 1;
      else dependency.positiveReferences += 1;
      if (isAggregateRule(group.clause)) dependency.aggregateReferences += 1;
    }
  }
  for (const group of constraints) {
    for (const goal of group.clause.body) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      const dependency = accumulator(predKey(literal));
      dependency.constraintReferences += 1;
      if (isNegation(goal)) dependency.negativeReferences += 1;
      else dependency.positiveReferences += 1;
    }
  }

  const stratified = stratifyProgram(view.clauses);
  const adjacency = new Map<string, Set<string>>();
  for (const group of rules) {
    const head = predKey(group.clause.head);
    const dependencies = adjacency.get(head) ?? new Set<string>();
    for (const goal of group.clause.body) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      dependencies.add(predKey(literal));
    }
    adjacency.set(head, dependencies);
  }
  const components = recursiveComponents([...accumulators.keys()], adjacency, rules);
  const recursiveKeys = new Set(components.flatMap(({ predicates }) => predicates));
  const predicateNodes = [...accumulators]
    .map(([key, value]): PredicateTopologyNode => {
      const factCount = value.factKeys.size;
      const ruleCount = value.ruleIds.size;
      return {
        id: predicateId(key),
        kind: 'predicate',
        key,
        predicate: value.predicate,
        arity: value.arity,
        stratum: stratified.predicateStrata.get(key) ?? 0,
        factCount,
        ruleCount,
        authoredRuleCount: value.authoredRules,
        positiveReferences: value.positiveReferences,
        negativeReferences: value.negativeReferences,
        aggregateReferences: value.aggregateReferences,
        constraintReferences: value.constraintReferences,
        openInput: factCount === 0 && ruleCount === 0,
        derivedOnly: factCount === 0 && ruleCount > 0,
        recursive: recursiveKeys.has(key),
        definitionNamespaces: [...value.sourceNamespaces].sort(),
        definitionOperationCount: value.sourceOperations.size,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const ruleNodes = rules.map((group): RuleTopologyNode => {
    const sources = sourceCopies(view.sources, group.key);
    return {
      id: ruleId(group.key),
      kind: 'rule',
      numbers: [...group.numbers],
      clause: serializeClause(group.clause),
      aggregate: isAggregateRule(group.clause),
      comparisonCount: group.clause.body.filter(isComparison).length,
      ...(sources === undefined ? {} : { sources }),
    };
  });
  const constraintNodes = constraints.map((group): ConstraintTopologyNode => {
    const sources = sourceCopies(view.sources, group.key);
    return {
      id: constraintId(group.key),
      kind: 'constraint',
      clause: serializeClause(group.clause),
      comparisonCount: group.clause.body.filter(isComparison).length,
      ...(sources === undefined ? {} : { sources }),
    };
  });
  const edges: KnowledgeTopologyEdge[] = [];
  const addEdge = (
    kind: KnowledgeTopologyEdge['kind'],
    from: string,
    to: string,
    position: number | undefined,
    aggregate = false
  ) => {
    edges.push({
      id: edgeId(kind, from, to, position, aggregate),
      kind,
      from,
      to,
      ...(position === undefined ? {} : { position }),
      ...(aggregate ? { aggregate: true } : {}),
    });
    assertTopologyLimit(edges.length, MAX_TOPOLOGY_EDGES, 'edges');
  };
  for (const group of rules) {
    const from = ruleId(group.key);
    addEdge('defines', from, predicateId(predKey(group.clause.head)), undefined);
    for (const [position, goal] of group.clause.body.entries()) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      addEdge(
        isNegation(goal) ? 'excludes' : 'requires',
        from,
        predicateId(predKey(literal)),
        position,
        isAggregateRule(group.clause)
      );
    }
  }
  for (const group of constraints) {
    const from = constraintId(group.key);
    for (const [position, goal] of group.clause.body.entries()) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      addEdge(
        isNegation(goal) ? 'excludes' : 'requires',
        from,
        predicateId(predKey(literal)),
        position
      );
    }
  }
  edges.sort((left, right) => left.id.localeCompare(right.id));
  const strataByNumber = new Map<number, string[]>();
  for (const predicate of predicateNodes) {
    const values = strataByNumber.get(predicate.stratum) ?? [];
    values.push(predicate.key);
    strataByNumber.set(predicate.stratum, values);
  }
  const result: KnowledgeTopologyResult = {
    predicateCount: predicateNodes.length,
    factCount: facts.size,
    ruleCount: ruleNodes.length,
    authoredRuleCount: authoredRuleNumber,
    constraintCount: constraintNodes.length,
    edgeCount: edges.length,
    predicates: predicateNodes,
    rules: ruleNodes,
    constraints: constraintNodes,
    strata: [...strataByNumber]
      .sort(([left], [right]) => left - right)
      .map(([stratum, predicates]) => ({ stratum, predicates: predicates.sort() })),
    recursiveComponents: components,
    openInputs: predicateNodes
      .filter(({ openInput }) => openInput)
      .map(({ key }) => key),
    openNegatedInputs: predicateNodes
      .filter(({ openInput, negativeReferences }) => openInput && negativeReferences > 0)
      .map(({ key }) => key),
    graph: {
      nodes: [...predicateNodes, ...ruleNodes, ...constraintNodes].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
      edges,
    },
    ...(trustMode === undefined || trustMode === 'accepted' ? {} : { trustMode }),
  };
  if (focus === undefined) return result;
  const resolvedFocus = resolveFocus(focus, predicateNodes);
  return selectTopology(result, resolvedFocus, direction ?? 'both');
}
