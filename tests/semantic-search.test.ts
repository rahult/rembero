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
} from '../src/knowledge/semantic-search.js';
import { MemoryStore } from '../src/store/store.js';
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
