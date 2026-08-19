export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedPromptTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface LlmCompletion {
  content: string;
  model: string;
  usage: LlmUsage;
}

export interface LlmUsageTotals {
  calls: number;
  usageResponses: number;
  costResponses: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';

function finiteNonnegative(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

export function emptyLlmUsageTotals(): LlmUsageTotals {
  return {
    calls: 0,
    usageResponses: 0,
    costResponses: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
}

export function addLlmUsage(
  totals: LlmUsageTotals,
  usage: LlmUsage
): LlmUsageTotals {
  const hasTokens =
    usage.promptTokens !== null ||
    usage.completionTokens !== null ||
    usage.totalTokens !== null;
  return {
    calls: totals.calls + 1,
    usageResponses: totals.usageResponses + (hasTokens ? 1 : 0),
    costResponses: totals.costResponses + (usage.costUsd === null ? 0 : 1),
    promptTokens: totals.promptTokens + (usage.promptTokens ?? 0),
    completionTokens: totals.completionTokens + (usage.completionTokens ?? 0),
    totalTokens: totals.totalTokens + (usage.totalTokens ?? 0),
    cachedPromptTokens: totals.cachedPromptTokens + (usage.cachedPromptTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: totals.costUsd + (usage.costUsd ?? 0),
  };
}

export class OpenRouterClient implements LlmClient {
  constructor(
    private config: LlmConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    return (await this.completeWithUsage(messages)).content;
  }

  async completeWithUsage(messages: ChatMessage[]): Promise<LlmCompletion> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          lastError = new Error(`LLM request failed with status ${response.status}`);
          if (response.status === 429 || response.status >= 500) continue;
          throw lastError;
        }
        const data = (await response.json()) as {
          model?: unknown;
          choices?: { message?: { content?: string } }[];
          usage?: {
            prompt_tokens?: unknown;
            completion_tokens?: unknown;
            total_tokens?: unknown;
            cost?: unknown;
            prompt_tokens_details?: { cached_tokens?: unknown };
            completion_tokens_details?: { reasoning_tokens?: unknown };
          };
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('LLM response had no message content');
        }
        const promptTokens = finiteNonnegative(data.usage?.prompt_tokens);
        const completionTokens = finiteNonnegative(data.usage?.completion_tokens);
        return {
          content,
          model: typeof data.model === 'string' ? data.model : this.config.model,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens:
              finiteNonnegative(data.usage?.total_tokens) ??
              (promptTokens !== null && completionTokens !== null
                ? promptTokens + completionTokens
                : null),
            cachedPromptTokens: finiteNonnegative(
              data.usage?.prompt_tokens_details?.cached_tokens
            ),
            reasoningTokens: finiteNonnegative(
              data.usage?.completion_tokens_details?.reasoning_tokens
            ),
            costUsd: finiteNonnegative(data.usage?.cost),
          },
        };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (!/status (429|5\d\d)|abort|fetch failed/i.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error('LLM request failed');
  }
}

/**
 * An LlmClient that resolves its configuration on first use, so the MCP server
 * can start (and serve the LLM-free tools) without an API key present.
 */
export function lazyClientFromEnv(): LlmClient {
  let client: OpenRouterClient | undefined;
  return {
    complete(messages) {
      client ??= clientFromEnv();
      return client.complete(messages);
    },
  };
}

export function clientFromEnv(env = process.env): OpenRouterClient {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set — add it to .env or the environment');
  }
  return new OpenRouterClient({
    apiKey,
    baseUrl: (env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: env.LLM_MODEL ?? DEFAULT_MODEL,
  });
}
