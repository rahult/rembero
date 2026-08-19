import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalKey,
  isIntegrityConstraint,
  serializeClause,
  type Clause,
} from '../engine/index.js';
import {
  MAX_EMBEDDING_DIMENSIONS,
  type EmbeddingClient,
  type EmbeddingUsage,
} from '../llm/embeddings.js';
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
export const MAX_SEMANTIC_CACHE_ENTRY_BYTES = 256 * 1024;
export const SEMANTIC_CACHE_VERSION = 'remembero.semantic-cache.v1' as const;
export const DEFAULT_SEMANTIC_PREPARE_LIMIT = 100;
export const MAX_SEMANTIC_PREPARE_LIMIT = 100;

const RECOMMENDATION_INTENT =
  /\b(recommend|suggest|suggestion|advice|tips|ideas?|should i|what should|decide|choose|looking for)\b/i;

export function isRecommendationIntent(text: string): boolean {
  return RECOMMENDATION_INTENT.test(text);
}

export interface EmbeddingCache {
  get(key: string): number[] | undefined;
  set(key: string, vector: number[]): void;
}

function validateCacheKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('embedding cache key must be a SHA-256 digest');
  }
}

function validateCacheVector(vector: number[]): void {
  if (
    vector.length < 1 ||
    vector.length > MAX_EMBEDDING_DIMENSIONS ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('embedding cache vector is invalid');
  }
}

export class MemoryEmbeddingCache implements EmbeddingCache {
  private readonly values = new Map<string, number[]>();

  constructor(private readonly maxEntries = DEFAULT_SEMANTIC_CACHE_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error('embedding cache entries must be from 1 to 10000');
    }
  }

  get(key: string): number[] | undefined {
    validateCacheKey(key);
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return [...value];
  }

  set(key: string, vector: number[]): void {
    validateCacheKey(key);
    validateCacheVector(vector);
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

interface SemanticCacheEntry {
  schemaVersion: typeof SEMANTIC_CACHE_VERSION;
  key: string;
  vector: number[];
  digest: string;
}

function entryDigest(entry: Omit<SemanticCacheEntry, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

export class FileEmbeddingCache implements EmbeddingCache {
  constructor(
    private readonly root: string,
    private readonly maxEntries = DEFAULT_SEMANTIC_CACHE_ENTRIES
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error('embedding cache entries must be from 1 to 10000');
    }
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      return;
    }
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('semantic cache root must be a real directory');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      chmodSync(this.root, 0o700);
    }
  }

  private path(key: string): string {
    validateCacheKey(key);
    return join(this.root, `${key}.json`);
  }

  get(key: string): number[] | undefined {
    validateCacheKey(key);
    if (!existsSync(this.root)) return undefined;
    this.ensureRoot();
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SEMANTIC_CACHE_ENTRY_BYTES) {
        return undefined;
      }
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SemanticCacheEntry>;
      if (
        parsed.schemaVersion !== SEMANTIC_CACHE_VERSION ||
        parsed.key !== key ||
        !Array.isArray(parsed.vector) ||
        typeof parsed.digest !== 'string'
      ) {
        return undefined;
      }
      const core = { schemaVersion: SEMANTIC_CACHE_VERSION, key, vector: parsed.vector };
      if (entryDigest(core) !== parsed.digest) return undefined;
      validateCacheVector(parsed.vector);
      return [...parsed.vector];
    } catch {
      return undefined;
    }
  }

  set(key: string, vector: number[]): void {
    validateCacheVector(vector);
    this.ensureRoot();
    const path = this.path(key);
    const core = { schemaVersion: SEMANTIC_CACHE_VERSION, key, vector: [...vector] };
    const entry: SemanticCacheEntry = { ...core, digest: entryDigest(core) };
    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body) > MAX_SEMANTIC_CACHE_ENTRY_BYTES) {
      throw new Error('embedding cache entry exceeds 256 KiB');
    }
    const temporary = join(this.root, `.${key}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (existsSync(path)) unlinkSync(path);
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.enforceBound();
  }

  private enforceBound(): void {
    const names = readdirSync(this.root)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length <= this.maxEntries) return;
    const entries = names
      .flatMap((name) => {
        const path = join(this.root, name);
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink()
          ? [{ name, mtimeMs: stat.mtimeMs }]
          : [];
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    for (const entry of entries.slice(0, Math.max(0, entries.length - this.maxEntries))) {
      unlinkSync(join(this.root, entry.name));
    }
  }

  get size(): number {
    if (!existsSync(this.root)) return 0;
    this.ensureRoot();
    return readdirSync(this.root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
  }
}

export class LayeredEmbeddingCache implements EmbeddingCache {
  constructor(
    private readonly memory: MemoryEmbeddingCache,
    private readonly file: FileEmbeddingCache
  ) {}

  get(key: string): number[] | undefined {
    const memory = this.memory.get(key);
    if (memory !== undefined) return memory;
    const file = this.file.get(key);
    if (file !== undefined) this.memory.set(key, file);
    return file;
  }

  set(key: string, vector: number[]): void {
    this.memory.set(key, vector);
    this.file.set(key, vector);
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
  deduplicatedDocuments: number;
  providerUsage: EmbeddingUsage;
  results: SemanticKnowledgeSearchResultItem[];
}

export interface SemanticKnowledgeSearchOptions extends Omit<KnowledgeSearchOptions, 'limit'> {
  limit?: number;
  candidateLimit?: number;
  cache?: EmbeddingCache;
}

export function semanticDocumentText(
  clause: string,
  sources: readonly MemorySource[]
): string {
  const source = sources
    .flatMap(({ text }) => text === undefined ? [] : [text])
    .join('\n');
  return (source === '' ? clause : source).slice(0, MAX_SEMANTIC_SOURCE_CHARS);
}

export function semanticEmbeddingCacheKey(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex');
}

function clauseKind(clause: Clause): KnowledgeSearchResultItem['kind'] {
  if (isIntegrityConstraint(clause)) return 'constraint';
  return clause.body.length === 0 ? 'fact' : 'rule';
}

export interface PrepareSemanticKnowledgeOptions {
  cache: EmbeddingCache;
  limit?: number;
  after?: string;
  kinds?: KnowledgeSearchOptions['kinds'];
}

export interface PrepareSemanticKnowledgeResult {
  status: 'complete' | 'more';
  model: string;
  selectedCount: number;
  cacheHits: number;
  cacheMisses: number;
  deduplicatedDocuments: number;
  nextCursor: string | null;
  providerUsage: EmbeddingUsage;
  results: Array<{
    key: string;
    clause: string;
    kind: KnowledgeSearchResultItem['kind'];
    sourceCount: number;
    cache: 'hit' | 'written';
  }>;
}

export async function prepareSemanticKnowledge(
  clauses: Clause[],
  sources: Map<string, MemorySource[]>,
  embeddings: EmbeddingClient,
  options: PrepareSemanticKnowledgeOptions
): Promise<PrepareSemanticKnowledgeResult> {
  const limit = options.limit ?? DEFAULT_SEMANTIC_PREPARE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEMANTIC_PREPARE_LIMIT) {
    throw new Error(`semantic prepare limit must be from 1 to ${MAX_SEMANTIC_PREPARE_LIMIT}`);
  }
  if (options.after !== undefined) assertBoundedInput(options.after, 'semantic prepare cursor');
  const kinds = new Set(options.kinds ?? ['fact', 'rule', 'constraint']);
  if (kinds.size === 0) throw new Error('semantic prepare kinds must not be empty');
  if ([...kinds].some((kind) => !['fact', 'rule', 'constraint'].includes(kind))) {
    throw new Error('semantic prepare kind must be fact, rule, or constraint');
  }
  const documents = new Map<string, {
    clause: string;
    kind: KnowledgeSearchResultItem['kind'];
    sources: MemorySource[];
    text: string;
  }>();
  for (const clause of clauses) {
    const kind = clauseKind(clause);
    if (!kinds.has(kind)) continue;
    const key = canonicalKey(clause);
    if (documents.has(key)) continue;
    const clauseSources = (sources.get(key) ?? []).map((source) => structuredClone(source));
    documents.set(key, {
      clause: serializeClause(clause),
      kind,
      sources: clauseSources,
      text: semanticDocumentText(serializeClause(clause), clauseSources),
    });
  }
  const remaining = [...documents.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .filter(([key]) => options.after === undefined || key > options.after);
  const selected = remaining.slice(0, limit);
  const documentKeys = selected.map(([, document]) =>
    semanticEmbeddingCacheKey(embeddings.model, document.text)
  );
  const vectors = documentKeys.map((key) => options.cache.get(key));
  const initialCacheHits = vectors.filter((vector) => vector !== undefined).length;
  const missing = new Map<string, { text: string; indexes: number[] }>();
  for (const [index, vector] of vectors.entries()) {
    if (vector !== undefined) continue;
    const key = documentKeys[index]!;
    const existing = missing.get(key);
    if (existing === undefined) {
      missing.set(key, { text: selected[index]![1].text, indexes: [index] });
    } else {
      existing.indexes.push(index);
    }
  }
  const missingDocuments = [...missing.entries()];
  for (const [, document] of missingDocuments) {
    assertSafeForExternalLlm(document.text, 'semantic knowledge source');
  }
  const embedded = missingDocuments.length === 0
    ? undefined
    : await embeddings.embed(missingDocuments.map(([, document]) => document.text));
  for (const [position, [key, document]] of missingDocuments.entries()) {
    const vector = embedded!.vectors[position]!;
    options.cache.set(key, vector);
    for (const index of document.indexes) vectors[index] = vector;
  }
  const more = remaining.length > selected.length;
  return {
    status: more ? 'more' : 'complete',
    model: embedded?.model ?? embeddings.model,
    selectedCount: selected.length,
    cacheHits: initialCacheHits,
    cacheMisses: missingDocuments.length,
    deduplicatedDocuments: selected.length - initialCacheHits - missingDocuments.length,
    nextCursor: more ? selected.at(-1)?.[0] ?? null : null,
    providerUsage: embedded?.usage ?? {
      promptTokens: null,
      totalTokens: null,
      costUsd: null,
    },
    results: selected.map(([key, document], index) => ({
      key,
      clause: document.clause,
      kind: document.kind,
      sourceCount: document.sources.length,
      cache: missing.has(documentKeys[index]!) ? 'written' : 'hit',
    })),
  };
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
      deduplicatedDocuments: 0,
      providerUsage: { promptTokens: null, totalTokens: null, costUsd: null },
      results: [],
    };
  }
  const documents = lexical.results.map((result) =>
    semanticDocumentText(result.clause, result.sources)
  );
  for (const document of documents) {
    assertSafeForExternalLlm(document, 'semantic knowledge source');
  }
  const cache = options.cache;
  const documentKeys = documents.map((document) =>
    semanticEmbeddingCacheKey(embeddings.model, document)
  );
  const cachedVectors = documentKeys.map((key) => cache?.get(key));
  const initialCacheHits = cachedVectors.filter((vector) => vector !== undefined).length;
  const missing = new Map<string, { text: string; indexes: number[] }>();
  for (const [index, vector] of cachedVectors.entries()) {
    if (vector !== undefined) continue;
    const key = documentKeys[index]!;
    const existing = missing.get(key);
    if (existing === undefined) {
      missing.set(key, { text: documents[index]!, indexes: [index] });
    } else {
      existing.indexes.push(index);
    }
  }
  const missingDocuments = [...missing.entries()];
  const embedded = await embeddings.embed([
    text,
    ...missingDocuments.map(([, document]) => document.text),
  ]);
  const queryVector = embedded.vectors[0]!;
  for (const [position, [key, document]] of missingDocuments.entries()) {
    const vector = embedded.vectors[position + 1]!;
    cache?.set(key, vector);
    for (const index of document.indexes) cachedVectors[index] = vector;
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
    cacheHits: initialCacheHits,
    cacheMisses: missingDocuments.length,
    deduplicatedDocuments: documents.length - initialCacheHits - missingDocuments.length,
    providerUsage: embedded.usage,
    results: ranked.map(({ result, lexicalRank, semanticScore }, index) => ({
      ...result,
      rank: index + 1,
      lexicalRank,
      semanticScore,
    })),
  };
}
