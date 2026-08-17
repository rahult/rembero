import { createHash } from 'node:crypto';
import {
  type Clause,
  canonicalKey,
  isAggregateRule,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  parseProgram,
  serializeClause,
} from '../engine/index.js';
import type { MemorySource } from '../store/store.js';

export const TENTATIVE_PREDICATE = 'rembero_tentative';
export const MAX_TENTATIVE_FACTS = 64;
export const MAX_TENTATIVE_CLAUSE_BYTES = 16 * 1024;

export type TrustViewMode = 'accepted' | 'include_tentative';
export type KnowledgeTrust = 'accepted' | 'tentative';
export type TentativeResolutionAction = 'accept' | 'reject';

export interface TentativeClaim {
  id: string;
  clause: string;
  declaration: string;
  sources?: MemorySource[];
}

export interface TrustProjection {
  projectedFrom: string;
  identityRewrites: [];
  trust: 'tentative';
}

export interface TrustKnowledgeView {
  clauses: Clause[];
  sources: Map<string, MemorySource[]>;
  projections: Map<string, TrustProjection[]>;
  acceptedKeys: Set<string>;
}

export class TrustMetadataError extends Error {
  readonly code = 'trust_metadata_error';

  constructor(message: string) {
    super(message);
    this.name = 'TrustMetadataError';
  }

  toJSON(): Record<string, string> {
    return { error: this.code, message: this.message };
  }
}

function mergeSources(
  destination: MemorySource[],
  incoming: MemorySource[] | undefined
): void {
  if (incoming === undefined) return;
  const seen = new Set(destination.map((source) => JSON.stringify(source)));
  for (const source of incoming) {
    const key = JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    destination.push(source);
  }
}

function assertOrdinaryGroundFact(clause: Clause, label: string): void {
  if (
    isIntegrityConstraint(clause) ||
    isAggregateRule(clause) ||
    clause.body.length !== 0 ||
    clause.head.args.some(
      (term) =>
        (term.type !== 'atom' && term.type !== 'num') ||
        (term.type === 'num' && !Number.isFinite(term.value))
    )
  ) {
    throw new TrustMetadataError(`${label} must be an ordinary ground fact`);
  }
  if (
    clause.head.predicate === TENTATIVE_PREDICATE ||
    clause.head.predicate === 'rembero_alias' ||
    clause.head.predicate === 'rembero_entity_position'
  ) {
    throw new TrustMetadataError(`${label} may not contain reserved metadata`);
  }
  const serialized = serializeClause(clause);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TENTATIVE_CLAUSE_BYTES) {
    throw new TrustMetadataError(
      `${label} exceeds ${MAX_TENTATIVE_CLAUSE_BYTES} bytes`
    );
  }
}

function declarationFor(clause: Clause): Clause {
  const serialized = serializeClause(clause);
  return {
    head: {
      predicate: TENTATIVE_PREDICATE,
      args: [{ type: 'atom', value: serialized }],
    },
    body: [],
  };
}

export function isTrustMetadataPredicate(predicate: string): boolean {
  return predicate === TENTATIVE_PREDICATE;
}

export function isTentativeDeclaration(clause: Clause): boolean {
  return clause.head.predicate === TENTATIVE_PREDICATE;
}

export function decodeTentativeDeclaration(clause: Clause): Clause | undefined {
  if (!isTentativeDeclaration(clause)) return undefined;
  if (isIntegrityConstraint(clause) || clause.body.length !== 0) {
    throw new TrustMetadataError(`${TENTATIVE_PREDICATE} declarations must be ground facts`);
  }
  const [encoded] = clause.head.args;
  if (clause.head.args.length !== 1 || encoded?.type !== 'atom') {
    throw new TrustMetadataError(
      `${TENTATIVE_PREDICATE} declarations require one encoded fact atom`
    );
  }
  if (Buffer.byteLength(encoded.value, 'utf8') > MAX_TENTATIVE_CLAUSE_BYTES) {
    throw new TrustMetadataError(
      `tentative fact exceeds ${MAX_TENTATIVE_CLAUSE_BYTES} bytes`
    );
  }
  let parsed: Clause[];
  try {
    parsed = parseProgram(encoded.value);
  } catch (error) {
    throw new TrustMetadataError(
      `tentative declaration contains invalid Datalog: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (parsed.length !== 1) {
    throw new TrustMetadataError('tentative declaration must contain exactly one fact');
  }
  const fact = parsed[0];
  assertOrdinaryGroundFact(fact, 'tentative declaration');
  return fact;
}

export function wrapTentativeFacts(input: string | Clause[]): Clause[] {
  const clauses = typeof input === 'string' ? parseProgram(input) : input;
  if (clauses.length === 0) {
    throw new TrustMetadataError('tentative assertion requires at least one fact');
  }
  if (clauses.length > MAX_TENTATIVE_FACTS) {
    throw new TrustMetadataError(
      `tentative assertion accepts at most ${MAX_TENTATIVE_FACTS} facts`
    );
  }
  return clauses.map((clause, index) => {
    assertOrdinaryGroundFact(clause, `tentative fact ${index + 1}`);
    return declarationFor(clause);
  });
}

export function tentativeClaimId(clause: Clause): string {
  const fact = decodeTentativeDeclaration(clause);
  if (fact === undefined) {
    throw new TrustMetadataError('claim ID requires a tentative declaration');
  }
  return `tentative:${createHash('sha256')
    .update(canonicalKey(clause))
    .digest('hex')}`;
}

function assertNoTrustBodyUse(clause: Clause): void {
  for (const goal of clause.body) {
    if (isComparison(goal)) continue;
    const literal = isNegation(goal) ? goal.not : goal;
    if (isTrustMetadataPredicate(literal.predicate)) {
      throw new TrustMetadataError(
        `${TENTATIVE_PREDICATE} is reserved trust metadata and cannot appear in rule or constraint bodies`
      );
    }
  }
}

export function assertTrustMetadataSafety(
  clauses: Clause[],
  allowTentativeDeclarations = false
): void {
  for (const clause of clauses) {
    assertNoTrustBodyUse(clause);
    if (!isTentativeDeclaration(clause)) continue;
    decodeTentativeDeclaration(clause);
    if (!allowTentativeDeclarations) {
      throw new TrustMetadataError(
        'raw clauses may not assign trust metadata; use the typed tentative or portable import surface'
      );
    }
  }
}

export function projectTrustKnowledge(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  mode: TrustViewMode = 'accepted'
): TrustKnowledgeView {
  if (mode !== 'accepted' && mode !== 'include_tentative') {
    throw new TrustMetadataError(
      "trust view mode must be 'accepted' or 'include_tentative'"
    );
  }
  assertTrustMetadataSafety(clauses, true);
  const projected: Clause[] = [];
  const sources = new Map<string, MemorySource[]>();
  const projections = new Map<string, TrustProjection[]>();
  const acceptedKeys = new Set<string>();

  for (const clause of clauses) {
    const tentative = decodeTentativeDeclaration(clause);
    if (tentative === undefined) {
      projected.push(clause);
      const key = canonicalKey(clause);
      acceptedKeys.add(key);
      const merged = sources.get(key) ?? [];
      mergeSources(merged, sourceIndex.get(key));
      if (merged.length > 0) sources.set(key, merged);
      continue;
    }
    if (mode === 'accepted') continue;

    projected.push(tentative);
    const key = canonicalKey(tentative);
    const declaration = serializeClause(clause);
    const evidence: TrustProjection = {
      projectedFrom: declaration,
      identityRewrites: [],
      trust: 'tentative',
    };
    const existing = projections.get(key) ?? [];
    if (!existing.some((candidate) => candidate.projectedFrom === declaration)) {
      existing.push(evidence);
      projections.set(key, existing);
    }
    const declarationSources = sourceIndex.get(canonicalKey(clause))?.map((source) => ({
      ...source,
      trust: 'tentative' as const,
      projectedFrom: declaration,
      identityRewrites: [],
    }));
    const merged = sources.get(key) ?? [];
    mergeSources(merged, declarationSources);
    if (merged.length > 0) sources.set(key, merged);
  }

  for (const entries of sources.values()) {
    entries.sort(
      (left, right) =>
        Number(left.trust === 'tentative') -
        Number(right.trust === 'tentative')
    );
  }

  return { clauses: projected, sources, projections, acceptedKeys };
}

export function listTentativeClaims(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]> = new Map()
): TentativeClaim[] {
  const claims: TentativeClaim[] = [];
  for (const declaration of clauses) {
    const fact = decodeTentativeDeclaration(declaration);
    if (fact === undefined) continue;
    const sources = sourceIndex.get(canonicalKey(declaration));
    claims.push({
      id: tentativeClaimId(declaration),
      clause: serializeClause(fact),
      declaration: serializeClause(declaration),
      ...(sources === undefined || sources.length === 0
        ? {}
        : { sources: [...sources] }),
    });
  }
  return claims;
}
