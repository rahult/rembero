import { createHash } from 'node:crypto';
import type { Clause } from '../engine/index.js';
import type { EmbeddingClient, EmbeddingUsage } from '../llm/embeddings.js';
import { assertBoundedInput, assertSafeForExternalLlm } from '../safety.js';
import type { MemorySource } from '../store/store.js';
import {
  MAX_KNOWLEDGE_SEARCH_LIMIT,
  searchKnowledge,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResultItem,
} from './search.js';

export const DEFAULT_SEMANTIC_SEARCH_CANDIDATES = 100;
export const MAX_SEMANTIC_SEARCH_CANDIDATES = 100;
export const MAX_SEMANTIC_SOURCE_CHARS = 16_384;
export const DEFAULT_SEMANTIC_CACHE_ENTRIES = 2_000;

const RECOMMENDATION_INTENT =
  /\b(recommend|suggest|suggestion|advice|tips|ideas?|should i|what should|decide|choose|looking for)\b/i;

export function isRecommendationIntent(text: string): boolean {
  return RECOMMENDATION_INTENT.test(text);
}

export class MemoryEmbeddingCache {
  private readonly values = new Map<string, number[]>();

  constructor(private readonly maxEntries = DEFAULT_SEMANTIC_CACHE_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error('embedding cache entries must be from 1 to 10000');
    }
  }

  get(key: string): number[] | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return [...value];
  }

  set(key: string, vector: number[]): void {
    this.values.delete(key);
    this.values.set(key, [...vector]);
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  get size(): number {
    return this.values.size;
  }
}

export interface SemanticKnowledgeSearchResultItem extends KnowledgeSearchResultItem {
  semanticScore: number;
  lexicalRank: number;
}

export interface SemanticKnowledgeSearchResult {
  status: 'matches' | 'no_match';
  text: string;
  route: 'semantic';
  model: string;
  candidateCount: number;
  returnedCount: number;
  limit: number;
  cacheHits: number;
  cacheMisses: number;
  providerUsage: EmbeddingUsage;
  results: SemanticKnowledgeSearchResultItem[];
}

export interface SemanticKnowledgeSearchOptions extends Omit<KnowledgeSearchOptions, 'limit'> {
  limit?: number;
  candidateLimit?: number;
  cache?: MemoryEmbeddingCache;
}

function rankingText(result: KnowledgeSearchResultItem): string {
  const source = result.sources
    .flatMap(({ text }) => text === undefined ? [] : [text])
    .join('\n');
  return (source === '' ? result.clause : source).slice(0, MAX_SEMANTIC_SOURCE_CHARS);
}

function cacheKey(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex');
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('embedding dimensions do not match');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export async function semanticSearchKnowledge(
  clauses: Clause[],
  text: string,
  sources: Map<string, MemorySource[]> = new Map(),
  embeddings: EmbeddingClient,
  options: SemanticKnowledgeSearchOptions = {}
): Promise<SemanticKnowledgeSearchResult> {
  assertBoundedInput(text, 'semantic knowledge search text');
  assertSafeForExternalLlm(text, 'semantic knowledge search text');
  const limit = options.limit ?? 20;
  const candidateLimit = options.candidateLimit ?? DEFAULT_SEMANTIC_SEARCH_CANDIDATES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_SEARCH_LIMIT) {
    throw new Error(`semantic search limit must be from 1 to ${MAX_KNOWLEDGE_SEARCH_LIMIT}`);
  }
  if (
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit < limit ||
    candidateLimit > MAX_SEMANTIC_SEARCH_CANDIDATES
  ) {
    throw new Error(
      `semantic search candidateLimit must be from ${limit} to ${MAX_SEMANTIC_SEARCH_CANDIDATES}`
    );
  }
  const lexicalOptions: KnowledgeSearchOptions = {
    ...(options.minimumScore === undefined ? {} : { minimumScore: options.minimumScore }),
    ...(options.sourceCharacterLimit === undefined
      ? {}
      : { sourceCharacterLimit: options.sourceCharacterLimit }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.entityIdentity === undefined
      ? {}
      : { entityIdentity: options.entityIdentity }),
    ...(options.trustMode === undefined ? {} : { trustMode: options.trustMode }),
  };
  const lexical = searchKnowledge(clauses, text, sources, {
    ...lexicalOptions,
    limit: candidateLimit,
  });
  if (lexical.results.length === 0) {
    return {
      status: 'no_match',
      text,
      route: 'semantic',
      model: embeddings.model,
      candidateCount: 0,
      returnedCount: 0,
      limit,
      cacheHits: 0,
      cacheMisses: 0,
      providerUsage: { promptTokens: null, totalTokens: null, costUsd: null },
      results: [],
    };
  }
  const documents = lexical.results.map(rankingText);
  for (const document of documents) {
    assertSafeForExternalLlm(document, 'semantic knowledge source');
  }
  const cache = options.cache;
  const cachedVectors = documents.map((document) =>
    cache?.get(cacheKey(embeddings.model, document))
  );
  const missingIndexes = cachedVectors.flatMap((vector, index) =>
    vector === undefined ? [index] : []
  );
  const embedded = await embeddings.embed([
    text,
    ...missingIndexes.map((index) => documents[index]!),
  ]);
  const queryVector = embedded.vectors[0]!;
  for (const [position, documentIndex] of missingIndexes.entries()) {
    const vector = embedded.vectors[position + 1]!;
    cachedVectors[documentIndex] = vector;
    cache?.set(cacheKey(embeddings.model, documents[documentIndex]!), vector);
  }
  const ranked = lexical.results
    .map((result, index) => ({
      result,
      lexicalRank: result.rank,
      semanticScore: cosineSimilarity(queryVector, cachedVectors[index]!),
    }))
    .sort(
      (left, right) =>
        right.semanticScore - left.semanticScore || left.lexicalRank - right.lexicalRank
    )
    .slice(0, limit);
  return {
    status: ranked.length === 0 ? 'no_match' : 'matches',
    text,
    route: 'semantic',
    model: embedded.model,
    candidateCount: lexical.results.length,
    returnedCount: ranked.length,
    limit,
    cacheHits: documents.length - missingIndexes.length,
    cacheMisses: missingIndexes.length,
    providerUsage: embedded.usage,
    results: ranked.map(({ result, lexicalRank, semanticScore }, index) => ({
      ...result,
      rank: index + 1,
      lexicalRank,
      semanticScore,
    })),
  };
}
