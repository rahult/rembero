import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenRouterEmbeddingClient,
  type EmbeddingClient,
} from '../src/llm/embeddings.js';
import {
  isRecommendationIntent,
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
