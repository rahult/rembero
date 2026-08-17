import {
  type Clause,
  type Goal,
  type Literal,
  type QuerySpec,
  type ScalarExpression,
  type Term,
  canonicalKey,
  isArithmeticExpression,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  serializeClause,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';
import {
  isTentativeDeclaration,
  isTrustMetadataPredicate,
  projectTrustKnowledge,
  type KnowledgeTrust,
  type TrustViewMode,
} from './trust.js';

export const ENTITY_ALIAS_PREDICATE = 'rembero_alias';
export const ENTITY_POSITION_PREDICATE = 'rembero_entity_position';
export const MAX_ENTITY_ALIASES = 10_000;
export const MAX_ENTITY_POSITIONS = 1_024;

export type EntityIdentityMode = 'canonical';

export interface EntityAlias {
  alias: string;
  target: string;
  canonical: string;
  sources?: MemorySource[];
}

export interface EntityPosition {
  predicate: string;
  arity: number;
  position: number;
  sources?: MemorySource[];
}

export interface EntityRewrite {
  predicate: string;
  arity: number;
  position: number;
  original: string;
  canonical: string;
  chain: EntityAlias[];
}

export interface EntityProjection {
  projectedFrom: string;
  identityRewrites: EntityRewrite[];
  trust?: Extract<KnowledgeTrust, 'tentative'>;
}

export class EntityIdentityError extends Error {
  readonly code = 'entity_identity_error';

  constructor(message: string) {
    super(message);
    this.name = 'EntityIdentityError';
  }
}

function reservedPredicate(predicate: string): boolean {
  return (
    predicate === ENTITY_ALIAS_PREDICATE ||
    predicate === ENTITY_POSITION_PREDICATE ||
    isTrustMetadataPredicate(predicate)
  );
}

export function isEntityMetadataPredicate(predicate: string): boolean {
  return reservedPredicate(predicate);
}

function declarationKind(clause: Clause): 'alias' | 'position' | undefined {
  if (clause.head.predicate === ENTITY_ALIAS_PREDICATE) return 'alias';
  if (clause.head.predicate === ENTITY_POSITION_PREDICATE) return 'position';
  return undefined;
}

function assertMetadataFact(clause: Clause, predicate: string): void {
  if (isIntegrityConstraint(clause) || clause.body.length !== 0) {
    throw new EntityIdentityError(`${predicate} declarations must be ground facts`);
  }
}

function aliasValues(clause: Clause): [string, string] | undefined {
  if (clause.head.predicate !== ENTITY_ALIAS_PREDICATE) return undefined;
  assertMetadataFact(clause, ENTITY_ALIAS_PREDICATE);
  const [alias, canonical] = clause.head.args;
  if (
    clause.head.args.length !== 2 ||
    alias?.type !== 'atom' ||
    canonical?.type !== 'atom'
  ) {
    throw new EntityIdentityError(
      `${ENTITY_ALIAS_PREDICATE} declarations require two atom values`
    );
  }
  return [alias.value, canonical.value];
}

function positionValue(clause: Clause): Omit<EntityPosition, 'sources'> | undefined {
  if (clause.head.predicate !== ENTITY_POSITION_PREDICATE) return undefined;
  assertMetadataFact(clause, ENTITY_POSITION_PREDICATE);
  const [predicate, arity, position] = clause.head.args;
  if (
    clause.head.args.length !== 3 ||
    predicate?.type !== 'atom' ||
    arity?.type !== 'num' ||
    position?.type !== 'num' ||
    !Number.isSafeInteger(arity.value) ||
    !Number.isSafeInteger(position.value) ||
    arity.value < 1 ||
    position.value < 0 ||
    position.value >= arity.value ||
    reservedPredicate(predicate.value)
  ) {
    throw new EntityIdentityError(
      `${ENTITY_POSITION_PREDICATE} requires an ordinary predicate atom, positive arity, and zero-based position below arity`
    );
  }
  return { predicate: predicate.value, arity: arity.value, position: position.value };
}

function assertNoReservedBodyUse(clause: Clause): void {
  for (const goal of clause.body) {
    if (isComparison(goal)) continue;
    const literal = isNegation(goal) ? goal.not : goal;
    if (reservedPredicate(literal.predicate)) {
      throw new EntityIdentityError(
        `${literal.predicate} is reserved identity metadata and cannot appear in rule or constraint bodies`
      );
    }
  }
}

function mergeSources(destination: MemorySource[], incoming: MemorySource[] | undefined): void {
  if (incoming === undefined) return;
  const seen = new Set(destination.map((source) => JSON.stringify(source)));
  for (const source of incoming) {
    const key = JSON.stringify(source);
    if (!seen.has(key)) {
      seen.add(key);
      destination.push(source);
    }
  }
}

function positionKey(predicate: string, arity: number, position: number): string {
  return `${predicate}/${arity}:${position}`;
}

export class EntityResolver {
  private readonly resolved = new Map<string, string>();
  private readonly aliasRecords: EntityAlias[];
  private readonly positionRecords: EntityPosition[];
  private readonly enabledPositions: Set<string>;

  constructor(
    direct: ReadonlyMap<string, string>,
    sourceByAlias: ReadonlyMap<string, MemorySource[]>,
    positions: ReadonlyMap<string, EntityPosition>
  ) {
    const visiting = new Set<string>();
    const resolve = (value: string): string => {
      const cached = this.resolved.get(value);
      if (cached !== undefined) return cached;
      const target = direct.get(value);
      if (target === undefined) return value;
      if (visiting.has(value)) {
        throw new EntityIdentityError(`entity alias cycle includes '${value}'`);
      }
      visiting.add(value);
      const canonical = resolve(target);
      visiting.delete(value);
      this.resolved.set(value, canonical);
      return canonical;
    };

    this.aliasRecords = [...direct.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([alias, target]) => ({
        alias,
        target,
        canonical: resolve(alias),
        ...(sourceByAlias.get(alias) === undefined
          ? {}
          : { sources: [...(sourceByAlias.get(alias) as MemorySource[])] }),
      }));
    this.positionRecords = [...positions.values()].sort(
      (left, right) =>
        left.predicate.localeCompare(right.predicate) ||
        left.arity - right.arity ||
        left.position - right.position
    );
    this.enabledPositions = new Set(positions.keys());
  }

  resolve(value: string): string {
    return this.resolved.get(value) ?? value;
  }

  aliases(): EntityAlias[] {
    return this.aliasRecords.map((record) => ({
      ...record,
      ...(record.sources === undefined ? {} : { sources: [...record.sources] }),
    }));
  }

  positions(): EntityPosition[] {
    return this.positionRecords.map((record) => ({
      ...record,
      ...(record.sources === undefined ? {} : { sources: [...record.sources] }),
    }));
  }

  aliasesFor(canonical: string): EntityAlias[] {
    return this.aliases().filter((record) => record.canonical === canonical);
  }

  isEntityPosition(predicate: string, arity: number, position: number): boolean {
    if (this.enabledPositions.has(positionKey(predicate, arity, position))) return true;
    if (predicate.endsWith('_until') && arity > 1) {
      return this.enabledPositions.has(
        positionKey(predicate.slice(0, -'_until'.length), arity - 1, position)
      );
    }
    return false;
  }

  private chain(value: string): EntityAlias[] {
    const records = new Map(this.aliasRecords.map((record) => [record.alias, record]));
    const chain: EntityAlias[] = [];
    let current = value;
    for (;;) {
      const record = records.get(current);
      if (record === undefined) return chain;
      chain.push({
        ...record,
        ...(record.sources === undefined ? {} : { sources: [...record.sources] }),
      });
      current = record.target;
    }
  }

  canonicalizeLiteral(literal: Literal): { literal: Literal; rewrites: EntityRewrite[] } {
    const arity = literal.args.length;
    const rewrites: EntityRewrite[] = [];
    const args = literal.args.map((term, position): Term => {
      if (
        term.type !== 'atom' ||
        !this.isEntityPosition(literal.predicate, arity, position)
      ) {
        return term;
      }
      const canonical = this.resolve(term.value);
      if (canonical === term.value) return term;
      rewrites.push({
        predicate: literal.predicate,
        arity,
        position,
        original: term.value,
        canonical,
        chain: this.chain(term.value),
      });
      return { type: 'atom', value: canonical };
    });
    return { literal: { predicate: literal.predicate, args }, rewrites };
  }

  canonicalizeExpression(expression: ScalarExpression): ScalarExpression {
    if (!isArithmeticExpression(expression)) return expression;
    if (expression.kind === 'unary') {
      return {
        kind: 'unary',
        op: expression.op,
        operand: this.canonicalizeExpression(expression.operand),
      };
    }
    return {
      kind: 'binary',
      op: expression.op,
      left: this.canonicalizeExpression(expression.left),
      right: this.canonicalizeExpression(expression.right),
    };
  }

  canonicalizeGoal(goal: Goal): { goal: Goal; rewrites: EntityRewrite[] } {
    if (isComparison(goal)) {
      return {
        goal: {
          op: goal.op,
          left: this.canonicalizeExpression(goal.left),
          right: this.canonicalizeExpression(goal.right),
        },
        rewrites: [],
      };
    }
    if (isNegation(goal)) {
      const result = this.canonicalizeLiteral(goal.not);
      return { goal: { not: result.literal }, rewrites: result.rewrites };
    }
    const result = this.canonicalizeLiteral(goal);
    return { goal: result.literal, rewrites: result.rewrites };
  }

  canonicalizeClause(clause: Clause): { clause: Clause; rewrites: EntityRewrite[] } {
    const body = clause.body.map((goal) => this.canonicalizeGoal(goal));
    if (isIntegrityConstraint(clause)) {
      return {
        clause: { ...clause, body: body.map((result) => result.goal) },
        rewrites: body.flatMap((result) => result.rewrites),
      };
    }
    const head = this.canonicalizeLiteral(clause.head);
    return {
      clause: {
        ...clause,
        head: head.literal,
        body: body.map((result) => result.goal),
      },
      rewrites: [...head.rewrites, ...body.flatMap((result) => result.rewrites)],
    };
  }

  canonicalizeQuery(query: QuerySpec): { query: QuerySpec; rewrites: EntityRewrite[] } {
    const goals = query.goals.map((goal) => this.canonicalizeGoal(goal));
    return {
      query:
        query.kind === 'relational'
          ? { ...query, goals: goals.map((result) => result.goal) }
          : { ...query, goals: goals.map((result) => result.goal) },
      rewrites: goals.flatMap((result) => result.rewrites),
    };
  }
}

export function buildEntityResolver(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map()
): EntityResolver {
  const direct = new Map<string, string>();
  const sourceByAlias = new Map<string, MemorySource[]>();
  const positions = new Map<string, EntityPosition>();
  for (const clause of clauses) {
    assertNoReservedBodyUse(clause);
    const alias = aliasValues(clause);
    if (alias !== undefined) {
      const [from, target] = alias;
      if (from === target) {
        throw new EntityIdentityError(`entity alias '${from}' cannot target itself`);
      }
      const previous = direct.get(from);
      if (previous !== undefined && previous !== target) {
        throw new EntityIdentityError(
          `entity alias '${from}' conflicts between '${previous}' and '${target}'`
        );
      }
      if (previous === undefined && direct.size >= MAX_ENTITY_ALIASES) {
        throw new EntityIdentityError(`entity aliases exceed ${MAX_ENTITY_ALIASES} declarations`);
      }
      direct.set(from, target);
      const sources = sourceByAlias.get(from) ?? [];
      mergeSources(sources, sourceIndex.get(canonicalKey(clause)));
      if (sources.length > 0) sourceByAlias.set(from, sources);
      continue;
    }

    const position = positionValue(clause);
    if (position === undefined) continue;
    const key = positionKey(position.predicate, position.arity, position.position);
    const existing = positions.get(key);
    if (existing === undefined) {
      if (positions.size >= MAX_ENTITY_POSITIONS) {
        throw new EntityIdentityError(
          `entity positions exceed ${MAX_ENTITY_POSITIONS} declarations`
        );
      }
      positions.set(key, {
        ...position,
        ...(sourceIndex.get(canonicalKey(clause)) === undefined
          ? {}
          : { sources: [...(sourceIndex.get(canonicalKey(clause)) as MemorySource[])] }),
      });
    } else {
      const sources = existing.sources ?? [];
      mergeSources(sources, sourceIndex.get(canonicalKey(clause)));
      if (sources.length > 0) existing.sources = sources;
    }
  }

  return new EntityResolver(direct, sourceByAlias, positions);
}

export interface CanonicalKnowledgeView {
  clauses: Clause[];
  sources: Map<string, MemorySource[]>;
  resolver: EntityResolver;
  /** Canonical claim keys that also exist literally in the selected store view. */
  exactClaims: Set<string>;
  /** Literal-to-canonical evidence independent of durable source availability. */
  projections: Map<string, EntityProjection[]>;
}

export function canonicalizeKnowledge(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  trustMode: TrustViewMode = 'accepted'
): CanonicalKnowledgeView {
  const trustView = projectTrustKnowledge(clauses, sourceIndex, trustMode);
  const resolver = buildEntityResolver(trustView.clauses, trustView.sources);
  const normalized: Clause[] = [];
  const sources = new Map<string, MemorySource[]>();
  const exactClaims = new Set<string>();
  const projections = new Map<string, EntityProjection[]>();
  const seen = new Set<string>();

  for (const original of trustView.clauses) {
    if (declarationKind(original) !== undefined) continue;
    const originalKey = canonicalKey(original);
    const trustProjections = trustView.projections.get(originalKey) ?? [];
    const { clause, rewrites } = resolver.canonicalizeClause(original);
    const key = canonicalKey(clause);
    if (rewrites.length === 0 && trustView.acceptedKeys.has(originalKey)) {
      exactClaims.add(key);
    }
    const evidenceRecords: EntityProjection[] =
      trustProjections.length > 0
        ? trustProjections.map((projection) => ({
            projectedFrom: projection.projectedFrom,
            identityRewrites: rewrites,
            trust: 'tentative',
          }))
        : rewrites.length > 0
          ? [
              {
                projectedFrom: serializeClause(original),
                identityRewrites: rewrites,
              },
            ]
          : [];
    for (const evidence of evidenceRecords) {
      const existing = projections.get(key) ?? [];
      if (!existing.some((candidate) => JSON.stringify(candidate) === JSON.stringify(evidence))) {
        existing.push(evidence);
        projections.set(key, existing);
      }
    }
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(clause);
    }
    const merged = sources.get(key) ?? [];
    const originalSources = trustView.sources.get(originalKey);
    mergeSources(
      merged,
      rewrites.length === 0 || originalSources === undefined
        ? originalSources
        : originalSources.map((source) => ({
            ...source,
            projectedFrom: source.projectedFrom ?? serializeClause(original),
            identityRewrites: [
              ...(source.identityRewrites ?? []),
              ...rewrites,
            ],
          }))
    );
    if (merged.length > 0) sources.set(key, merged);
  }

  // An exact literal source is the primary witness whenever it exists. Alias-derived
  // sources remain available as alternatives in deterministic clause/source order.
  for (const entries of sources.values()) {
    entries.sort(
      (left, right) => Number(left.projectedFrom !== undefined) - Number(right.projectedFrom !== undefined)
    );
  }

  return { clauses: normalized, sources, resolver, exactClaims, projections };
}

export function literalKnowledge(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  trustMode: TrustViewMode = 'accepted'
): CanonicalKnowledgeView {
  // Literal reads deliberately do not interpret or validate identity metadata.
  // This keeps the pre-identity query contract stable even when a namespace
  // contains declarations that a canonical read would reject.
  const trustView = projectTrustKnowledge(clauses, sourceIndex, trustMode);
  const resolver = new EntityResolver(new Map(), new Map(), new Map());
  const visibleClauses = trustView.clauses.filter(
    (clause) => declarationKind(clause) === undefined
  );
  const visibleKeys = new Set(visibleClauses.map(canonicalKey));
  const visibleSources = new Map<string, MemorySource[]>();
  for (const clause of visibleClauses) {
    const key = canonicalKey(clause);
    const sources = trustView.sources.get(key);
    if (sources !== undefined) visibleSources.set(key, [...sources]);
  }
  return {
    clauses: visibleClauses,
    sources: visibleSources,
    resolver,
    exactClaims: new Set(
      [...visibleKeys].filter((key) => trustView.acceptedKeys.has(key))
    ),
    projections: new Map(
      [...trustView.projections].filter(([key]) => visibleKeys.has(key))
    ),
  };
}

export function isEntityMetadataDeclaration(clause: Clause): boolean {
  return declarationKind(clause) !== undefined || isTentativeDeclaration(clause);
}
