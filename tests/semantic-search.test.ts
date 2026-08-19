import {
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenRouterEmbeddingClient,
  type EmbeddingClient,
} from '../src/llm/embeddings.js';
import {
  isRecommendationIntent,
  FileEmbeddingCache,
  LayeredEmbeddingCache,
  MemoryEmbeddingCache,
  semanticSearchKnowledge,
  prepareSemanticKnowledge,
  semanticDocumentChunks,
} from '../src/knowledge/semantic-search.js';
import { MemoryStore } from '../src/store/store.js';
import { canonicalKey, parseProgram } from '../src/engine/index.js';
import { semanticSearchKnowledgeTool } from '../src/mcp/tools.js';

function store(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-semantic-${label}-`)));
}

describe('semantic knowledge search', () => {
  it('reranks a bounded lexical shortlist and caches document vectors', async () => {
    const memory = store('ranking');
    memory.assert('default', 'note(relevant).', {
      opId: 'relevant',
      sourceText: 'Recommend a Sony flash for the A7R IV photography setup.',
    });
    memory.assert('default', 'note(distractor).', {
      opId: 'distractor',
      sourceText: 'Recommend a camera-shaped cake for the party.',
    });
    const calls: string[][] = [];
    const embeddings: EmbeddingClient = {
      model: 'test/embedding',
      async embed(inputs) {
        calls.push(inputs);
        return {
          model: this.model,
          vectors: inputs.map((input, index) =>
            index === 0 || input.includes('Sony') ? [1, 0] : [0, 1]
          ),
          usage: { promptTokens: inputs.length * 10, totalTokens: inputs.length * 10, costUsd: 0.001 },
        };
      },
    };
    const cache = new MemoryEmbeddingCache();
    const first = await semanticSearchKnowledge(
      memory.clausesFor(['default']),
      'Can you recommend camera accessories?',
      memory.sourcesFor(['default']),
      embeddings,
      { limit: 2, cache }
    );
    expect(first).toMatchObject({
      status: 'matches',
      route: 'semantic',
      candidateCount: 2,
      cacheHits: 0,
      cacheMisses: 2,
      results: [
        { rank: 1, lexicalRank: expect.any(Number), sources: [{ opId: 'relevant' }] },
        { rank: 2, lexicalRank: expect.any(Number), sources: [{ opId: 'distractor' }] },
      ],
    });
    const second = await semanticSearchKnowledge(
      memory.clausesFor(['default']),
      'Can you recommend camera accessories?',
      memory.sourcesFor(['default']),
      embeddings,
      { limit: 2, cache }
    );
    expect(second).toMatchObject({ cacheHits: 2, cacheMisses: 0 });
    expect(calls.map((inputs) => inputs.length)).toEqual([3, 1]);
    expect(cache.size).toBe(2);
  });

  it('recognizes recommendation intent without treating similarity as proof', () => {
    expect(isRecommendationIntent('Can you recommend a hotel?')).toBe(true);
    expect(isRecommendationIntent('Any tips for my camera setup?')).toBe(true);
    expect(isRecommendationIntent('Where does Maya work?')).toBe(false);
  });

  it('persists only derived vectors and recovers from corrupt cache entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-semantic-file-cache-'));
    const key = createHash('sha256').update('entry').digest('hex');
    const cache = new FileEmbeddingCache(root, 2);
    cache.set(key, [0.25, 0.75]);
    expect(new FileEmbeddingCache(root, 2).get(key)).toEqual([0.25, 0.75]);
    const path = join(root, `${key}.json`);
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    writeFileSync(path, '{"corrupt":true}', 'utf8');
    expect(cache.get(key)).toBeUndefined();
    cache.set(createHash('sha256').update('two').digest('hex'), [1, 0]);
    cache.set(createHash('sha256').update('three').digest('hex'), [0, 1]);
    expect(cache.size).toBe(2);
    expect(readdirSync(root).every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked cache root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rembero-semantic-symlink-'));
    const target = join(parent, 'target');
    const link = join(parent, 'cache');
    const targetCache = new FileEmbeddingCache(target);
    const key = createHash('sha256').update('symlink-target').digest('hex');
    targetCache.set(key, [1, 0]);
    symlinkSync(target, link, 'dir');
    expect(() => new FileEmbeddingCache(link).get(key)).toThrow(/real directory/i);
  });

  it('reuses document vectors across cache instances and invalidates by model and source', async () => {
    const memory = store('persistent-ranking');
    memory.assert('default', 'note(relevant).', {
      opId: 'relevant',
      sourceText: 'Recommend Sony camera accessories.',
    });
    memory.assert('default', 'note(other).', {
      opId: 'other',
      sourceText: 'Recommend baking accessories.',
    });
    const root = mkdtempSync(join(tmpdir(), 'rembero-semantic-persistent-'));
    const calls: Array<{ model: string; inputs: number }> = [];
    const client = (model: string): EmbeddingClient => ({
      model,
      async embed(inputs) {
        calls.push({ model, inputs: inputs.length });
        return {
          model,
          vectors: inputs.map((input, index) =>
            index === 0 || input.includes('Sony') ? [1, 0] : [0, 1]
          ),
          usage: { promptTokens: inputs.length, totalTokens: inputs.length, costUsd: 0 },
        };
      },
    });
    const run = (embeddings: EmbeddingClient, sources = memory.sourcesFor(['default'])) =>
      semanticSearchKnowledge(
        memory.clausesFor(['default']),
        'Recommend camera accessories',
        sources,
        embeddings,
        {
          limit: 2,
          cache: new LayeredEmbeddingCache(
            new MemoryEmbeddingCache(),
            new FileEmbeddingCache(root)
          ),
        }
      );
    await run(client('model/a'));
    const warm = await run(client('model/a'));
    expect(warm).toMatchObject({ cacheHits: 2, cacheMisses: 0 });
    await run(client('model/b'));
    const changedSources = memory.sourcesFor(['default']);
    const relevant = [...changedSources.entries()].find(([key]) => key.includes('relevant'));
    expect(relevant).toBeDefined();
    relevant![1][0]!.text = 'Recommend premium Sony camera accessories.';
    await run(client('model/a'), changedSources);
    expect(calls).toEqual([
      { model: 'model/a', inputs: 3 },
      { model: 'model/a', inputs: 1 },
      { model: 'model/b', inputs: 3 },
      { model: 'model/a', inputs: 2 },
    ]);
  });

  it('prepares deterministic resumable batches and skips cached documents', async () => {
    const memory = store('prepare');
    memory.assert('default', 'note(alpha).', { sourceText: 'Recommend alpha context.' });
    memory.assert('default', 'note(beta).', { sourceText: 'Recommend beta context.' });
    memory.assert('default', 'note(gamma).', { sourceText: 'Recommend gamma context.' });
    const calls: number[] = [];
    const embeddings: EmbeddingClient = {
      model: 'test/prepare',
      async embed(inputs) {
        calls.push(inputs.length);
        return {
          model: this.model,
          vectors: inputs.map((_, index) => [index + 1, 1]),
          usage: { promptTokens: inputs.length, totalTokens: inputs.length, costUsd: 0 },
        };
      },
    };
    const cache = new MemoryEmbeddingCache();
    const first = await prepareSemanticKnowledge(
      memory.clausesFor(['default']),
      memory.sourcesFor(['default']),
      embeddings,
      { cache, limit: 2, kinds: ['fact'] }
    );
    expect(first).toMatchObject({
      status: 'more',
      selectedCount: 2,
      cacheHits: 0,
      cacheMisses: 2,
      nextCursor: expect.any(String),
      results: [{ cache: 'written' }, { cache: 'written' }],
    });
    const second = await prepareSemanticKnowledge(
      memory.clausesFor(['default']),
      memory.sourcesFor(['default']),
      embeddings,
      { cache, limit: 2, after: first.nextCursor!, kinds: ['fact'] }
    );
    expect(second).toMatchObject({
      status: 'complete',
      selectedCount: 1,
      cacheMisses: 1,
      nextCursor: null,
    });
    const repeated = await prepareSemanticKnowledge(
      memory.clausesFor(['default']),
      memory.sourcesFor(['default']),
      embeddings,
      { cache, limit: 2, kinds: ['fact'] }
    );
    expect(repeated).toMatchObject({ cacheHits: 2, cacheMisses: 0 });
    expect(calls).toEqual([2, 1]);
  });

  it('embeds shared provenance once per batch', async () => {
    const memory = store('prepare-deduplicate');
    memory.assert('default', 'note(alpha). note(beta).', {
      sourceText: 'One shared recommendation source.',
    });
    const embed = vi.fn(async (inputs: string[]) => ({
      model: 'test/deduplicate',
      vectors: inputs.map(() => [1, 0]),
      usage: { promptTokens: inputs.length, totalTokens: inputs.length, costUsd: 0 },
    }));
    const prepared = await prepareSemanticKnowledge(
      memory.clausesFor(['default']),
      memory.sourcesFor(['default']),
      { model: 'test/deduplicate', embed },
      { cache: new MemoryEmbeddingCache(), limit: 2 }
    );
    expect(prepared).toMatchObject({
      selectedCount: 2,
      cacheHits: 0,
      cacheMisses: 1,
      deduplicatedChunks: 1,
    });
    expect(embed).toHaveBeenCalledWith(['One shared recommendation source.']);
  });

  it('uses the best bounded source chunk for semantic ranking', async () => {
    const memory = store('chunk-ranking');
    memory.assert('default', 'note(relevant).', {
      opId: 'relevant',
      sourceText: `Sony A7R IV accessories fit this camera setup. ${'unrelated context '.repeat(900)}`,
    });
    memory.assert('default', 'note(other).', {
      opId: 'other',
      sourceText: 'Camera-shaped cake decorations for a party.',
    });
    const embeddings: EmbeddingClient = {
      model: 'test/chunks',
      async embed(inputs) {
        return {
          model: this.model,
          vectors: inputs.map((input, index) =>
            index === 0 || input.includes('cake decorations') ? [1, 0] : [0, 1]
          ),
          usage: { promptTokens: inputs.length, totalTokens: inputs.length, costUsd: 0 },
        };
      },
    };
    const result = await semanticSearchKnowledge(
      memory.clausesFor(['default']),
      'Recommend accessories for my camera setup',
      memory.sourcesFor(['default']),
      embeddings,
      { limit: 2, cache: new MemoryEmbeddingCache() }
    );
    expect(result).toMatchObject({
      providerCalls: 1,
      lexicalGuardApplied: true,
      results: [
        {
          sources: [{ opId: 'relevant' }],
          semanticChunkIndex: 0,
          semanticChunkCount: 10,
        },
        { sources: [{ opId: 'other' }], semanticChunkCount: 1 },
      ],
    });
    expect(semanticDocumentChunks('fallback.', [{
      namespace: 'default',
      opId: 'long',
      ts: new Date(0).toISOString(),
      text: 'x'.repeat(20_000),
    }])).toHaveLength(10);
  });

  it('batches large preparation sets at the provider boundary', async () => {
    const clauses = parseProgram(
      Array.from({ length: 11 }, (_, index) => `note(item_${index}).`).join('\n')
    );
    const sources = new Map(clauses.map((clause, index) => [canonicalKey(clause), [{
      namespace: 'default',
      opId: `source-${index}`,
      ts: new Date(0).toISOString(),
      text: Array.from(
        { length: 10 },
        (_, chunk) => `document-${index}-chunk-${chunk}:` +
          String.fromCharCode(65 + chunk).repeat(2_000)
      ).join(''),
    }]]));
    const calls: number[] = [];
    const result = await prepareSemanticKnowledge(
      clauses,
      sources,
      {
        model: 'test/batches',
        async embed(inputs) {
          calls.push(inputs.length);
          return {
            model: this.model,
            vectors: inputs.map(() => [1, 0]),
            usage: { promptTokens: inputs.length, totalTokens: inputs.length, costUsd: 0 },
          };
        },
      },
      { cache: new MemoryEmbeddingCache(), limit: 11 }
    );
    expect(result).toMatchObject({
      selectedCount: 11,
      chunkCount: 110,
      cacheMisses: 110,
      providerCalls: 2,
    });
    expect(calls).toEqual([100, 10]);
  });

  it('blocks sensitive preparation before embedding', async () => {
    const clauses = parseProgram('note(secret_record).');
    const sources = new Map([[canonicalKey(clauses[0]!), [{
      namespace: 'default',
      opId: 'secret',
      ts: new Date(0).toISOString(),
      text: 'The API key is sk-example-secret-value.',
    }]]]);
    const embed = vi.fn();
    await expect(prepareSemanticKnowledge(
      clauses,
      sources,
      { model: 'test/embedding', embed },
      { cache: new MemoryEmbeddingCache() }
    )).rejects.toThrow(/sensitive/i);
    expect(embed).not.toHaveBeenCalled();
  });

  it('validates provider vectors and preserves native usage', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: 'provider/model',
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.000004 },
    }), { status: 200 }));
    const client = new OpenRouterEmbeddingClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'configured/model',
    }, fetchFn as typeof fetch);
    await expect(client.embed(['query', 'document'])).resolves.toEqual({
      model: 'provider/model',
      vectors: [[1, 0], [0, 1]],
      usage: { promptTokens: 12, totalTokens: 12, costUsd: 0.000004 },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('returns bounded actionable provider errors without echoing sensitive text', async () => {
    const client = new OpenRouterEmbeddingClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'configured/model',
    }, vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'No endpoints satisfy the configured privacy policy.' },
    }), { status: 404 })) as typeof fetch);
    await expect(client.embed(['query'])).rejects.toThrow(
      /status 404: No endpoints satisfy the configured privacy policy/i
    );

    const secretClient = new OpenRouterEmbeddingClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'configured/model',
    }, vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'API key is sk-sensitive-value' },
    }), { status: 400 })) as typeof fetch);
    await expect(secretClient.embed(['query'])).rejects.toThrow(/^embedding request failed with status 400$/i);
  });

  it('blocks local-only namespaces before calling the provider', async () => {
    const memory = store('allowlist');
    memory.assert('private', 'preference(rahul, tea).', {
      sourceText: 'Rahul prefers tea recommendations.',
    });
    const embed = vi.fn();
    await expect(semanticSearchKnowledgeTool({
      store: memory,
      embeddings: { model: 'test/embedding', embed },
      llmAllowedNamespaces: new Set(['shared']),
    }, {
      text: 'Can you recommend a drink?',
      namespaces: ['private'],
    })).rejects.toThrow(/local-only/i);
    expect(embed).not.toHaveBeenCalled();
  });
});
