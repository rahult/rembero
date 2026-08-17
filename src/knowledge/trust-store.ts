import { createHash } from 'node:crypto';
import { serializeClause, type Clause } from '../engine/index.js';
import type {
  MemoryStore,
  MutationContext,
} from '../store/store.js';
import {
  listTentativeClaims,
  type TentativeClaim,
  type TentativeResolutionAction,
} from './trust.js';

export const MAX_TENTATIVE_REVIEW_CLAIMS = 1_000;

export interface StoredTentativeClaim extends TentativeClaim {
  namespace: string;
}

export interface TentativeAssertionResult {
  added: string[];
  duplicates: number;
  opId: string;
}

export interface TentativeResolutionResult {
  action: TentativeResolutionAction;
  resolved: number;
  added: string[];
  duplicates: number;
  opId: string;
}

function storedClaimId(namespace: string, claimId: string): string {
  return `tentative:${createHash('sha256')
    .update(JSON.stringify([namespace, claimId]))
    .digest('hex')}`;
}

export function reviewTentativeClaims(
  store: MemoryStore,
  namespaces: string[] | '*' = '*'
): StoredTentativeClaim[] {
  const selected = [
    ...new Set(namespaces === '*' ? store.listNamespaces() : namespaces),
  ];
  if (selected.length > 32) throw new Error('tentative review namespace list exceeds 32');
  const claims: StoredTentativeClaim[] = [];
  for (const namespace of selected) {
    for (const claim of listTentativeClaims(
      store.load(namespace),
      store.sourcesFor([namespace])
    )) {
      claims.push({
        ...claim,
        id: storedClaimId(namespace, claim.id),
        namespace,
      });
      if (claims.length > MAX_TENTATIVE_REVIEW_CLAIMS) {
        throw new Error(
          `tentative review exceeds ${MAX_TENTATIVE_REVIEW_CLAIMS} claims`
        );
      }
    }
  }
  return claims;
}

export function assertTentativeFacts(
  store: MemoryStore,
  namespace: string,
  clauses: string | Clause[],
  context: MutationContext = {}
): TentativeAssertionResult {
  const result = store.assertTentative(namespace, clauses, context);
  return {
    added: result.added.map((declaration) => {
      const [encoded] = declaration.head.args;
      if (encoded?.type !== 'atom') throw new Error('invalid stored tentative declaration');
      return encoded.value;
    }),
    duplicates: result.duplicates,
    opId: result.opId,
  };
}

export function resolveTentativeFacts(
  store: MemoryStore,
  namespace: string,
  clauses: string | Clause[],
  action: TentativeResolutionAction,
  context: MutationContext = {}
): TentativeResolutionResult {
  const result = store.resolveTentative(namespace, clauses, action, context);
  return {
    action,
    resolved: result.retracted,
    added: result.added.map(serializeClause),
    duplicates: result.duplicates,
    opId: result.opId,
  };
}
