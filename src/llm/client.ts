export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';

export class OpenRouterClient implements LlmClient {
  constructor(
    private config: LlmConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
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
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('LLM response had no message content');
        }
        return content;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (!/status (429|5\d\d)|abort|fetch failed/i.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error('LLM request failed');
  }
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
