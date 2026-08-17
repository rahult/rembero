import { createHash } from 'node:crypto';
import {
  type Clause,
  type Goal,
  type ScalarExpression,
  type Term,
  canonicalKey,
  isArithmeticExpression,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  predKey,
  serializeClause,
} from '../engine/index.js';
import { recallEditDistance, recallWords } from '../llm/schema.js';
import { assertBoundedInput } from '../safety.js';
import type { MemorySource } from '../store/store.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityIdentityMode,
} from './identity.js';
import type { TrustViewMode } from './trust.js';

export const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;
export const MAX_KNOWLEDGE_SEARCH_LIMIT = 100;
export const MAX_KNOWLEDGE_SEARCH_CLAUSES = 100_000;
export const MAX_KNOWLEDGE_SEARCH_SOURCE_CHARS = 4_096;
export const MAX_KNOWLEDGE_SEARCH_WORDS = 256;
const MAX_FUZZY_WORD_CHARS = 64;

export type KnowledgeSearchClauseKind = 'fact' | 'rule' | 'constraint';
export type KnowledgeSearchReasonKind =
  | 'source_phrase'
  | 'clause_phrase'
  | 'head_predicate'
  | 'body_predicate'
  | 'term'
  | 'source_word'
  | 'clause_word'
  | 'fuzzy_predicate';

export interface KnowledgeSearchReason {
  kind: KnowledgeSearchReasonKind;
  token: string;
  points: number;
}

export interface KnowledgeSearchResultItem {
  id: string;
  rank: number;
  kind: KnowledgeSearchClauseKind;
  clause: string;
  score: number;
  reasons: KnowledgeSearchReason[];
  predicateKeys: string[];
  sources: MemorySource[];
  trust?: 'tentative';
  rankingSourceTruncated?: true;
}

export type KnowledgeSearchGraphNode =
  | { id: string; kind: 'search'; text: string; words: string[] }
  | { id: string; kind: 'result'; rank: number; score: number }
  | {
      id: string;
      kind: 'clause';
      clauseKind: KnowledgeSearchClauseKind;
      clause: string;
      sources: MemorySource[];
      trust?: 'tentative';
    }
  | { id: string; kind: 'predicate'; key: string; predicate: string; arity: number }
  | { id: string; kind: 'entity'; value: string | number; valueType: 'atom' | 'number' };

export interface KnowledgeSearchGraphEdge {
  id: string;
  kind: 'returns' | 'matches' | 'defines' | 'depends_on' | 'arg';
  from: string;
  to: string;
  position?: number;
}

export interface KnowledgeSearchGraph {
  nodes: KnowledgeSearchGraphNode[];
  edges: KnowledgeSearchGraphEdge[];
}

export interface KnowledgeSearchOptions {
  limit?: number;
  kinds?: KnowledgeSearchClauseKind[];
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
}

export interface KnowledgeSearchResult {
  status: 'matches' | 'no_match';
  text: string;
  words: string[];
  totalCandidates: number;
  matchCount: number;
  returnedCount: number;
  limit: number;
  truncated: boolean;
  results: KnowledgeSearchResultItem[];
  graph: KnowledgeSearchGraph;
  trustMode?: TrustViewMode;
}

const clauseKindOrder: Record<KnowledgeSearchClauseKind, number> = {
  fact: 0,
  rule: 1,
  constraint: 2,
};

interface ClauseDocument {
  clause: Clause;
  key: string;
  serialized: string;
  kind: KnowledgeSearchClauseKind;
  headPredicateWords: Set<string>;
  bodyPredicateWords: Set<string>;
  termWords: Set<string>;
  clauseWords: Set<string>;
  sourceWords: Set<string>;
  sourceText: string;
  sourceTruncated: boolean;
  headPredicateKey?: string;
  bodyPredicates: Array<{ key: string; position: number }>;
  predicateKeys: string[];
  sources: MemorySource[];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function clauseKind(clause: Clause): KnowledgeSearchClauseKind {
  if (isIntegrityConstraint(clause)) return 'constraint';
  return clause.body.length === 0 ? 'fact' : 'rule';
}

function expressionTerms(expression: ScalarExpression, result: Term[]): void {
  if (!isArithmeticExpression(expression)) {
    result.push(expression);
    return;
  }
  if (expression.kind === 'unary') expressionTerms(expression.operand, result);
  else {
    expressionTerms(expression.left, result);
    expressionTerms(expression.right, result);
  }
}

function goalTerms(goal: Goal): Term[] {
  if (isComparison(goal)) {
    const result: Term[] = [];
    expressionTerms(goal.left, result);
    expressionTerms(goal.right, result);
    return result;
  }
  return (isNegation(goal) ? goal.not : goal).args;
}

function termSearchWords(term: Term): string[] {
  if (term.type === 'atom') return recallWords(term.value);
  if (term.type === 'num') return [String(term.value)];
  return [];
}

function predicateForGoal(goal: Goal): string | undefined {
  if (isComparison(goal)) return undefined;
  return predKey(isNegation(goal) ? goal.not : goal);
}

function sourceRankingText(sources: MemorySource[]): {
  text: string;
  truncated: boolean;
} {
  let remaining = MAX_KNOWLEDGE_SEARCH_SOURCE_CHARS;
  const values: string[] = [];
  let truncated = false;
  for (const source of sources) {
    if (source.text === undefined) continue;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const selected = source.text.slice(0, remaining);
    values.push(selected);
    remaining -= selected.length;
    if (selected.length < source.text.length) truncated = true;
  }
  return { text: values.join(' '), truncated };
}

function documentFor(
  clause: Clause,
  sources: Map<string, MemorySource[]>
): ClauseDocument {
  const key = canonicalKey(clause);
  const serialized = serializeClause(clause);
  const clauseSources = (sources.get(key) ?? []).map((source) =>
    structuredClone(source)
  );
  const rankingSource = sourceRankingText(clauseSources);
  const headPredicateWords = new Set<string>();
  if (!isIntegrityConstraint(clause)) {
    for (const word of recallWords(clause.head.predicate)) {
      headPredicateWords.add(word);
    }
  }
  const bodyPredicateWords = new Set<string>();
  const predicateKeys = new Set<string>();
  const headPredicateKey = isIntegrityConstraint(clause)
    ? undefined
    : predKey(clause.head);
  if (headPredicateKey !== undefined) predicateKeys.add(headPredicateKey);
  const bodyPredicates: Array<{ key: string; position: number }> = [];
  for (const [position, goal] of clause.body.entries()) {
    const key = predicateForGoal(goal);
    if (key === undefined) continue;
    bodyPredicates.push({ key, position });
    predicateKeys.add(key);
    const predicate = key.slice(0, key.lastIndexOf('/'));
    for (const word of recallWords(predicate)) bodyPredicateWords.add(word);
  }
  const terms = [
    ...(isIntegrityConstraint(clause) ? [] : clause.head.args),
    ...clause.body.flatMap(goalTerms),
  ];
  return {
    clause,
    key,
    serialized,
    kind: clauseKind(clause),
    headPredicateWords,
    bodyPredicateWords,
    termWords: new Set(terms.flatMap(termSearchWords)),
    clauseWords: new Set(recallWords(serialized)),
    sourceWords: new Set(recallWords(rankingSource.text)),
    sourceText: rankingSource.text.toLowerCase(),
    sourceTruncated: rankingSource.truncated,
    ...(headPredicateKey === undefined ? {} : { headPredicateKey }),
    bodyPredicates,
    predicateKeys: [...predicateKeys].sort(),
    sources: clauseSources,
  };
}

function addReason(
  reasons: Map<string, KnowledgeSearchReason>,
  kind: KnowledgeSearchReasonKind,
  token: string,
  points: number
): void {
  const key = `${kind}\0${token}`;
  if (!reasons.has(key)) reasons.set(key, { kind, token, points });
}

function scoreDocument(
  document: ClauseDocument,
  text: string,
  words: string[]
): { score: number; reasons: KnowledgeSearchReason[] } {
  const reasons = new Map<string, KnowledgeSearchReason>();
  const lower = text.toLowerCase().trim();
  if (lower.length > 0 && document.sourceText.includes(lower)) {
    addReason(reasons, 'source_phrase', lower, 180);
  }
  if (lower.length > 0 && document.serialized.toLowerCase().includes(lower)) {
    addReason(reasons, 'clause_phrase', lower, 160);
  }
  for (const word of words) {
    if (document.headPredicateWords.has(word)) {
      addReason(reasons, 'head_predicate', word, 120);
    }
    if (document.bodyPredicateWords.has(word)) {
      addReason(reasons, 'body_predicate', word, 70);
    }
    if (document.termWords.has(word)) addReason(reasons, 'term', word, 60);
    if (document.sourceWords.has(word)) addReason(reasons, 'source_word', word, 45);
    if (document.clauseWords.has(word)) addReason(reasons, 'clause_word', word, 20);
  }
  for (const predicateWord of new Set([
    ...document.headPredicateWords,
    ...document.bodyPredicateWords,
  ])) {
    if (
      predicateWord.length < 4 ||
      predicateWord.length > MAX_FUZZY_WORD_CHARS ||
      words.includes(predicateWord)
    ) {
      continue;
    }
    const match = words.find(
      (word) =>
        word.length >= 4 &&
        word.length <= MAX_FUZZY_WORD_CHARS &&
        recallEditDistance(predicateWord, word) <= 1
    );
    if (match !== undefined) {
      addReason(reasons, 'fuzzy_predicate', match, 30);
    }
  }
  const values = [...reasons.values()].sort(
    (left, right) =>
      right.points - left.points ||
      left.kind.localeCompare(right.kind) ||
      left.token.localeCompare(right.token)
  );
  return {
    score: values.reduce((total, reason) => total + reason.points, 0),
    reasons: values,
  };
}

function predicateParts(key: string): { predicate: string; arity: number } {
  const slash = key.lastIndexOf('/');
  return { predicate: key.slice(0, slash), arity: Number(key.slice(slash + 1)) };
}

function groundHeadEntities(clause: Clause): Array<{ value: string | number; position: number }> {
  if (isIntegrityConstraint(clause)) return [];
  return clause.head.args.flatMap((term, position) =>
    term.type === 'atom' || term.type === 'num'
      ? [{ value: term.value, position }]
      : []
  );
}

function graphFor(
  text: string,
  words: string[],
  ranked: Array<{ document: ClauseDocument; result: KnowledgeSearchResultItem }>
): KnowledgeSearchGraph {
  const searchId = stableId('search', [text, words]);
  const nodes = new Map<string, KnowledgeSearchGraphNode>([
    [searchId, { id: searchId, kind: 'search', text, words }],
  ]);
  const edges = new Map<string, KnowledgeSearchGraphEdge>();
  const addEdge = (
    kind: KnowledgeSearchGraphEdge['kind'],
    from: string,
    to: string,
    position?: number
  ) => {
    const id = stableId('search-edge', [kind, from, to, position]);
    edges.set(id, {
      id,
      kind,
      from,
      to,
      ...(position === undefined ? {} : { position }),
    });
  };
  for (const { document, result } of ranked) {
    const resultId = stableId('search-result', [searchId, result.rank, result.id]);
    const clauseId = `clause:${createHash('sha256').update(document.key).digest('hex')}`;
    nodes.set(resultId, {
      id: resultId,
      kind: 'result',
      rank: result.rank,
      score: result.score,
    });
    nodes.set(clauseId, {
      id: clauseId,
      kind: 'clause',
      clauseKind: result.kind,
      clause: result.clause,
      sources: result.sources,
      ...(result.trust === undefined ? {} : { trust: result.trust }),
    });
    addEdge('returns', searchId, resultId, result.rank);
    addEdge('matches', resultId, clauseId);
    if (document.headPredicateKey !== undefined) {
      const key = document.headPredicateKey;
      const id = `predicate:${key}`;
      nodes.set(id, { id, kind: 'predicate', key, ...predicateParts(key) });
      addEdge('defines', clauseId, id);
    }
    for (const { key, position } of document.bodyPredicates) {
      const id = `predicate:${key}`;
      nodes.set(id, { id, kind: 'predicate', key, ...predicateParts(key) });
      addEdge('depends_on', clauseId, id, position);
    }
    for (const entity of groundHeadEntities(document.clause)) {
      const valueType = typeof entity.value === 'number' ? 'number' : 'atom';
      const id = stableId('entity', [valueType, entity.value]);
      nodes.set(id, { id, kind: 'entity', value: entity.value, valueType });
      addEdge('arg', clauseId, id, entity.position);
    }
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function validatedKinds(
  kinds: KnowledgeSearchClauseKind[] | undefined
): Set<KnowledgeSearchClauseKind> {
  const resolved = kinds ?? ['fact', 'rule', 'constraint'];
  if (resolved.length === 0) throw new Error('knowledge search kinds must not be empty');
  for (const kind of resolved) {
    if (kind !== 'fact' && kind !== 'rule' && kind !== 'constraint') {
      throw new Error("knowledge search kind must be 'fact', 'rule', or 'constraint'");
    }
  }
  return new Set(resolved);
}

/** Search readable knowledge locally with fixed, inspectable lexical scoring. */
export function searchKnowledge(
  clauses: Clause[],
  text: string,
  sourceIndex: Map<string, MemorySource[]> = new Map(),
  options: KnowledgeSearchOptions = {}
): KnowledgeSearchResult {
  assertBoundedInput(text, 'knowledge search text');
  const words = [...new Set(recallWords(text))];
  if (words.length === 0) throw new Error('knowledge search text has no searchable words');
  if (words.length > MAX_KNOWLEDGE_SEARCH_WORDS) {
    throw new Error(
      `knowledge search text exceeds ${MAX_KNOWLEDGE_SEARCH_WORDS} words`
    );
  }
  const limit = options.limit ?? DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_SEARCH_LIMIT) {
    throw new Error(`knowledge search limit must be from 1 to ${MAX_KNOWLEDGE_SEARCH_LIMIT}`);
  }
  const kinds = validatedKinds(options.kinds);
  const trustMode = options.trustMode ?? 'accepted';
  const view = options.entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sourceIndex, trustMode)
    : literalKnowledge(clauses, sourceIndex, trustMode);
  const documents: ClauseDocument[] = [];
  const seen = new Set<string>();
  for (const clause of view.clauses) {
    const key = canonicalKey(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    const document = documentFor(clause, view.sources);
    if (!kinds.has(document.kind)) continue;
    documents.push(document);
    if (documents.length > MAX_KNOWLEDGE_SEARCH_CLAUSES) {
      throw new Error(
        `knowledge search exceeds ${MAX_KNOWLEDGE_SEARCH_CLAUSES} clauses`
      );
    }
  }
  const matches = documents
    .map((document) => ({ document, ...scoreDocument(document, text, words) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        clauseKindOrder[left.document.kind] - clauseKindOrder[right.document.kind] ||
        left.document.serialized.localeCompare(right.document.serialized)
    );
  const returned = matches.slice(0, limit).map(({ document, score, reasons }, index) => {
    const trust =
      document.sources.length > 0 &&
      document.sources.every((source) => source.trust === 'tentative')
      ? ('tentative' as const)
      : undefined;
    const result: KnowledgeSearchResultItem = {
      id: stableId('knowledge-match', document.key),
      rank: index + 1,
      kind: document.kind,
      clause: document.serialized,
      score,
      reasons,
      predicateKeys: document.predicateKeys,
      sources: document.sources,
      ...(trust === undefined ? {} : { trust }),
      ...(document.sourceTruncated ? { rankingSourceTruncated: true } : {}),
    };
    return { document, result };
  });
  return {
    status: matches.length === 0 ? 'no_match' : 'matches',
    text,
    words,
    totalCandidates: documents.length,
    matchCount: matches.length,
    returnedCount: returned.length,
    limit,
    truncated: matches.length > returned.length,
    results: returned.map(({ result }) => result),
    graph: graphFor(text, words, returned),
    ...(trustMode === 'accepted' ? {} : { trustMode }),
  };
}
