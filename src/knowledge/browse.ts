import {
  type Clause,
  type Term,
  canonicalKey,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  predKey,
  EngineLimitError,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import type {
  ClaimGraphNode,
  EntityGraphNode,
  ExplanationGraph,
  ExplanationGraphEdge,
  ExplanationGraphNode,
} from './graph.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityIdentityMode,
  type EntityProjection,
  type EntityResolver,
} from './identity.js';
import type { TrustViewMode } from './trust.js';

export const DEFAULT_BROWSE_GRAPH_DEPTH = 1;
export const MAX_BROWSE_GRAPH_DEPTH = 8;
export const DEFAULT_BROWSE_GRAPH_CLAIMS = 100;
export const MAX_BROWSE_GRAPH_CLAIMS = 1_000;
export const MAX_BROWSE_GRAPH_NODES = 5_000;
export const MAX_BROWSE_GRAPH_FACTS = 100_000;
export const MAX_BROWSE_PREDICATE_FOCUS_BYTES = 256;
export const MAX_BROWSE_ENTITY_FOCUS_BYTES = 2_048;

export interface BrowseKnowledgeGraphOptions {
  focus?: string | number;
  predicate?: string;
  depth?: number;
  maxClaims?: number;
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
}

export interface BrowseKnowledgeGraphSelection {
  focus?: string | number;
  resolvedFocus?: string | number;
  focusNodeIds: string[];
  predicate?: string;
  depth: number;
  totalGroundFacts: number;
  selectedClaims: number;
  selectedEntities: number;
  /** True when no unselected claim remains adjacent to the final entity frontier. */
  frontierExhausted: boolean;
}

export interface BrowseKnowledgeGraphResult {
  status: 'matches' | 'no_match';
  graph: ExplanationGraph;
  selection: BrowseKnowledgeGraphSelection;
  skippedNonGroundFacts: number;
  trustMode?: TrustViewMode;
}

interface FactRecord {
  id: string;
  key: string;
  clause: Clause;
  predicateKey: string;
  predicate: string;
  values: (string | number)[];
  entityKeys: string[];
  sources: MemorySource[];
  projection?: EntityProjection;
  trust?: 'tentative';
}

function typedValue(value: string | number): ['atom' | 'number', string | number] {
  return [typeof value === 'number' ? 'number' : 'atom', value];
}

function entityKey(value: string | number): string {
  return JSON.stringify(typedValue(value));
}

export function knowledgeGraphEntityId(value: string | number): string {
  return `entity:${entityKey(value)}`;
}

function claimId(predicate: string, values: (string | number)[]): string {
  return `claim:${JSON.stringify([
    predicate,
    values.map((value) => typedValue(value)),
  ])}`;
}

function graphEdge(
  kind: ExplanationGraphEdge['kind'],
  from: string,
  to: string,
  position?: number
): ExplanationGraphEdge {
  return {
    id: `edge:${JSON.stringify([kind, from, to, position ?? null, null])}`,
    kind,
    from,
    to,
    ...(position === undefined ? {} : { position }),
  };
}

function groundValue(term: Term): string | number | undefined {
  if (term.type === 'atom' || term.type === 'num') return term.value;
  return undefined;
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

function resolvePredicate(
  requested: string | undefined,
  availableKeys: string[]
): string | undefined {
  if (requested === undefined) return undefined;
  if (Buffer.byteLength(requested, 'utf8') > MAX_BROWSE_PREDICATE_FOCUS_BYTES) {
    throw new Error(
      `graph predicate focus exceeds ${MAX_BROWSE_PREDICATE_FOCUS_BYTES} bytes`
    );
  }
  const trimmed = requested.trim();
  const explicit = trimmed.match(/^([a-z][a-zA-Z0-9_]*)\/(\d+)$/);
  const keys = [...new Set(availableKeys)].sort();
  if (explicit !== null) {
    const key = `${explicit[1]}/${Number(explicit[2])}`;
    if (!keys.includes(key)) throw new Error(`graph predicate '${key}' is not present`);
    return key;
  }
  if (!/^[a-z][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("graph predicate must be 'predicate' or 'predicate/arity'");
  }
  const matches = keys.filter((key) => key.slice(0, key.lastIndexOf('/')) === trimmed);
  if (matches.length === 0) throw new Error(`graph predicate '${trimmed}' is not present`);
  if (matches.length > 1) {
    throw new Error(`graph predicate '${trimmed}' is ambiguous: ${matches.join(', ')}`);
  }
  return matches[0];
}

function programPredicateKeys(clauses: Clause[]): string[] {
  const keys = new Set<string>();
  for (const clause of clauses) {
    if (!isIntegrityConstraint(clause)) keys.add(predKey(clause.head));
    for (const goal of clause.body) {
      if (isComparison(goal)) continue;
      keys.add(predKey(isNegation(goal) ? goal.not : goal));
    }
  }
  return [...keys].sort();
}

function recordsFor(
  clauses: Clause[],
  sources: Map<string, MemorySource[]>,
  projections: ReadonlyMap<string, EntityProjection[]>,
  exactClaims: ReadonlySet<string>
): { records: FactRecord[]; skipped: number } {
  const records: FactRecord[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const clause of clauses) {
    if (isIntegrityConstraint(clause) || clause.body.length !== 0) continue;
    const key = canonicalKey(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    const values = clause.head.args.map(groundValue);
    if (values.some((value) => value === undefined)) {
      skipped += 1;
      continue;
    }
    const ground = values as (string | number)[];
    const factSources = (sources.get(key) ?? []).map((source) =>
      structuredClone(source)
    );
    const exact = exactClaims.has(key);
    const projection = exact ? undefined : projections.get(key)?.[0];
    const trust =
      !exact &&
      (projection?.trust === 'tentative' ||
        (factSources.length > 0 &&
          factSources.every((source) => source.trust === 'tentative')))
        ? ('tentative' as const)
        : undefined;
    records.push({
      id: claimId(clause.head.predicate, ground),
      key,
      clause,
      predicateKey: predKey(clause.head),
      predicate: clause.head.predicate,
      values: ground,
      entityKeys: ground.map(entityKey),
      sources: factSources,
      ...(projection === undefined ? {} : { projection }),
      ...(trust === undefined ? {} : { trust }),
    });
    if (records.length > MAX_BROWSE_GRAPH_FACTS) {
      throw new EngineLimitError(
        `knowledge graph browse exceeded ${MAX_BROWSE_GRAPH_FACTS} ground facts`
      );
    }
  }
  return { records, skipped };
}

function claimNode(record: FactRecord): ClaimGraphNode {
  return {
    id: record.id,
    kind: 'claim',
    predicate: record.predicate,
    values: record.values,
    derived: false,
    ...(record.sources.length === 0 ? {} : { sources: record.sources }),
    ...(record.projection?.projectedFrom === undefined
      ? {}
      : { projectedFrom: record.projection.projectedFrom }),
    ...(record.projection?.identityRewrites === undefined
      ? {}
      : { identityRewrites: record.projection.identityRewrites }),
    ...(record.trust === undefined ? {} : { trust: record.trust }),
  };
}

function entityNode(
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

/** Browse a bounded neighborhood over explicit stored ground facts. */
export function browseKnowledgeGraph(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: BrowseKnowledgeGraphOptions = {}
): BrowseKnowledgeGraphResult {
  if (options.focus === undefined && options.predicate === undefined) {
    throw new Error('knowledge graph browse requires an entity focus or predicate');
  }
  if (
    typeof options.focus === 'string' &&
    Buffer.byteLength(options.focus, 'utf8') > MAX_BROWSE_ENTITY_FOCUS_BYTES
  ) {
    throw new Error(
      `knowledge graph entity focus exceeds ${MAX_BROWSE_ENTITY_FOCUS_BYTES} bytes`
    );
  }
  if (typeof options.focus === 'number' && !Number.isFinite(options.focus)) {
    throw new Error('knowledge graph numeric focus must be finite');
  }
  const depth = boundedInteger(
    options.depth,
    DEFAULT_BROWSE_GRAPH_DEPTH,
    MAX_BROWSE_GRAPH_DEPTH,
    'knowledge graph depth'
  );
  const maxClaims = boundedInteger(
    options.maxClaims,
    DEFAULT_BROWSE_GRAPH_CLAIMS,
    MAX_BROWSE_GRAPH_CLAIMS,
    'knowledge graph claim limit'
  );
  const trustMode = options.trustMode ?? 'accepted';
  const view = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode)
    : literalKnowledge(clauses, sourceIndex, trustMode);
  const { records, skipped } = recordsFor(
    view.clauses,
    view.sources,
    view.projections,
    view.exactClaims
  );
  const predicate = resolvePredicate(
    options.predicate,
    programPredicateKeys(view.clauses)
  );
  const requestedFocus = options.focus;
  const resolvedFocus =
    typeof requestedFocus === 'string' && options.entityIdentity === 'canonical'
      ? view.resolver.resolve(requestedFocus)
      : requestedFocus;
  const focusValues = new Set<string>();
  if (requestedFocus !== undefined) focusValues.add(entityKey(requestedFocus));
  if (resolvedFocus !== undefined) focusValues.add(entityKey(resolvedFocus));

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const entityClaims = new Map<string, string[]>();
  for (const record of records) {
    for (const key of record.entityKeys) {
      const values = entityClaims.get(key) ?? [];
      values.push(record.id);
      entityClaims.set(key, values);
    }
  }
  const selectedClaims = new Set<string>();
  const selectedEntities = new Set<string>(focusValues);
  let frontier = new Set<string>(focusValues);
  const addClaim = (id: string, nextEntities: Set<string>) => {
    if (selectedClaims.has(id)) return;
    if (selectedClaims.size >= maxClaims) {
      throw new EngineLimitError(
        `knowledge graph browse exceeded ${maxClaims} claims`
      );
    }
    const entityKeys = recordsById.get(id)?.entityKeys ?? [];
    const newEntityCount = new Set(
      entityKeys.filter((key) => !selectedEntities.has(key))
    ).size;
    if (
      selectedClaims.size +
        1 +
        selectedEntities.size +
        newEntityCount >
      MAX_BROWSE_GRAPH_NODES
    ) {
      throw new EngineLimitError(
        `knowledge graph browse exceeded ${MAX_BROWSE_GRAPH_NODES} nodes`
      );
    }
    selectedClaims.add(id);
    for (const key of entityKeys) {
      if (!selectedEntities.has(key)) nextEntities.add(key);
      selectedEntities.add(key);
    }
  };

  const seedIds = records
    .filter((record) => {
      const entityMatch =
        focusValues.size === 0 ||
        record.entityKeys.some((key) => focusValues.has(key));
      const predicateMatch = predicate === undefined || record.predicateKey === predicate;
      return entityMatch && predicateMatch;
    })
    .map(({ id }) => id);
  const initialEntities = new Set<string>();
  for (const id of seedIds) addClaim(id, initialEntities);
  frontier = initialEntities;

  for (let level = 1; level < depth; level++) {
    const nextEntities = new Set<string>();
    const claimIds = new Set<string>();
    for (const key of frontier) {
      for (const id of entityClaims.get(key) ?? []) claimIds.add(id);
    }
    for (const id of claimIds) addClaim(id, nextEntities);
    frontier = nextEntities;
    if (frontier.size === 0) break;
  }

  const nodes = new Map<string, ExplanationGraphNode>();
  const edges = new Map<string, ExplanationGraphEdge>();
  for (const key of selectedEntities) {
    const [, value] = JSON.parse(key) as ['atom' | 'number', string | number];
    nodes.set(knowledgeGraphEntityId(value), entityNode(value, view.resolver));
  }
  for (const id of selectedClaims) {
    const record = recordsById.get(id)!;
    nodes.set(id, claimNode(record));
    for (const [position, value] of record.values.entries()) {
      const target = knowledgeGraphEntityId(value);
      nodes.set(target, entityNode(value, view.resolver));
      const edge = graphEdge('arg', id, target, position);
      edges.set(edge.id, edge);
    }
  }
  if (nodes.size > MAX_BROWSE_GRAPH_NODES) {
    throw new EngineLimitError(
      `knowledge graph browse exceeded ${MAX_BROWSE_GRAPH_NODES} nodes`
    );
  }
  const focusNodeIds = [...focusValues]
    .map((key) => {
      const [, value] = JSON.parse(key) as ['atom' | 'number', string | number];
      return knowledgeGraphEntityId(value);
    })
    .sort();
  const frontierExhausted = [...frontier].every((key) =>
    (entityClaims.get(key) ?? []).every((id) => selectedClaims.has(id))
  );
  const graph: ExplanationGraph = {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    status: selectedClaims.size === 0 ? 'no_match' : 'matches',
    graph,
    selection: {
      ...(requestedFocus === undefined ? {} : { focus: requestedFocus }),
      ...(resolvedFocus === undefined ? {} : { resolvedFocus }),
      focusNodeIds,
      ...(predicate === undefined ? {} : { predicate }),
      depth,
      totalGroundFacts: records.length,
      selectedClaims: selectedClaims.size,
      selectedEntities: selectedEntities.size,
      frontierExhausted,
    },
    skippedNonGroundFacts: skipped,
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  };
}
