import { assertBoundedInput } from '../safety.js';

export const DEFAULT_EMBEDDING_MODEL = 'perplexity/pplx-embed-v1-0.6b';
export const MAX_EMBEDDING_INPUTS = 101;
export const MAX_EMBEDDING_DIMENSIONS = 4_096;
const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface EmbeddingUsage {
  promptTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface EmbeddingResult {
  model: string;
  vectors: number[][];
  usage: EmbeddingUsage;
}

export interface EmbeddingClient {
  readonly model: string;
  embed(inputs: string[]): Promise<EmbeddingResult>;
}

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function finiteNonnegative(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

export class OpenRouterEmbeddingClient implements EmbeddingClient {
  readonly model: string;

  constructor(
    private readonly config: EmbeddingConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.model = config.model;
  }

  async embed(inputs: string[]): Promise<EmbeddingResult> {
    if (inputs.length < 1 || inputs.length > MAX_EMBEDDING_INPUTS) {
      throw new Error(`embedding input count must be from 1 to ${MAX_EMBEDDING_INPUTS}`);
    }
    for (const input of inputs) assertBoundedInput(input, 'embedding input');
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetchFn(`${this.config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            input: inputs,
            encoding_format: 'float',
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
          lastError = new Error(`embedding request failed with status ${response.status}`);
          if (response.status === 429 || response.status >= 500) continue;
          throw lastError;
        }
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_EMBEDDING_RESPONSE_BYTES) {
          throw new Error('embedding response exceeds 16 MiB');
        }
        const payload = JSON.parse(body) as {
          model?: unknown;
          data?: Array<{ index?: unknown; embedding?: unknown }>;
          usage?: { prompt_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
        };
        if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
          throw new Error('embedding response count does not match the request');
        }
        const ordered = [...payload.data].sort((left, right) => {
          const leftIndex = typeof left.index === 'number' ? left.index : -1;
          const rightIndex = typeof right.index === 'number' ? right.index : -1;
          return leftIndex - rightIndex;
        });
        if (ordered.some(({ index }, position) => index !== position)) {
          throw new Error('embedding response indexes are incomplete or duplicated');
        }
        const vectors = ordered.map(({ embedding }, index) => {
          if (
            !Array.isArray(embedding) ||
            embedding.length < 1 ||
            embedding.length > MAX_EMBEDDING_DIMENSIONS ||
            embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
          ) {
            throw new Error(`embedding response vector ${index} is invalid`);
          }
          return [...embedding] as number[];
        });
        const dimensions = vectors[0]!.length;
        if (vectors.some((vector) => vector.length !== dimensions)) {
          throw new Error('embedding response dimensions do not match');
        }
        return {
          model: typeof payload.model === 'string' ? payload.model : this.model,
          vectors,
          usage: {
            promptTokens: finiteNonnegative(payload.usage?.prompt_tokens),
            totalTokens: finiteNonnegative(payload.usage?.total_tokens),
            costUsd: finiteNonnegative(payload.usage?.cost),
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!/status (429|5\d\d)|abort|fetch failed/i.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error('embedding request failed');
  }
}

export function embeddingClientFromEnv(env = process.env): OpenRouterEmbeddingClient {
  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set — semantic search requires an embedding provider');
  }
  return new OpenRouterEmbeddingClient({
    apiKey,
    baseUrl: (env.REMBERO_EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: env.REMBERO_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
  });
}

export function lazyEmbeddingClientFromEnv(env = process.env): EmbeddingClient {
  let client: OpenRouterEmbeddingClient | undefined;
  return {
    get model() {
      return client?.model ?? env.REMBERO_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    },
    embed(inputs) {
      client ??= embeddingClientFromEnv(env);
      return client.embed(inputs);
    },
  };
}
