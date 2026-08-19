import type {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  InitProgressReport,
  MLCEngineInterface,
} from "@mlc-ai/web-llm";

export type BrowserModelMode = "browser" | "webllm" | "simulated";
export type BrowserModelFallbackReason =
  | "unsupported"
  | "not_ready"
  | "runtime_error";
export type BrowserModelErrorStage =
  | "capability"
  | "availability"
  | "create"
  | "prompt";

export type BrowserModelResult =
  | {
      status: "generated";
      text: string;
      runtime: "native" | "webllm";
      durationMs: number;
    }
  | {
      status: "fallback";
      reason: BrowserModelFallbackReason;
      stage: BrowserModelErrorStage;
      availability?: string;
      runtime?: "native" | "webllm";
    };

interface BrowserLanguageModelSession {
  prompt(input: string): Promise<string>;
  destroy?(): void;
}

interface BrowserLanguageModelApi {
  availability(): Promise<string>;
  create(options: {
    initialPrompts: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
  }): Promise<BrowserLanguageModelSession>;
}

export const WEB_LLM_MODEL_ID = "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC";
export const WEB_LLM_MODEL_LABEL = "Hermes 2 Pro Mistral 7B";
export const WEB_LLM_VRAM_MB = 4033;

export interface WebLlmProgress {
  progress: number;
  text: string;
}

export type WebLlmLoadResult =
  | { status: "ready"; modelId: string; loadMs: number }
  | { status: "error"; reason: "webgpu_unsupported" | "load_failed" };

export type BrowserToolCallResult =
  | {
      status: "generated";
      call: ChatCompletionMessageToolCall;
      raw: string;
      runtime: "webllm";
      durationMs: number;
    }
  | {
      status: "fallback";
      reason: BrowserModelFallbackReason;
      stage: BrowserModelErrorStage;
      runtime: "webllm";
    };

let webLlmEngine: MLCEngineInterface | null = null;
let webLlmLoadPromise: Promise<WebLlmLoadResult> | null = null;

function browserLanguageModel(): BrowserLanguageModelApi | undefined {
  const candidate = (globalThis as typeof globalThis & {
    LanguageModel?: Partial<BrowserLanguageModelApi>;
  }).LanguageModel;
  if (
    candidate === undefined ||
    typeof candidate.availability !== "function" ||
    typeof candidate.create !== "function"
  ) {
    return undefined;
  }
  return candidate as BrowserLanguageModelApi;
}

export async function promptAvailableBrowserModel(
  systemPrompt: string,
  userPrompt: string,
): Promise<BrowserModelResult> {
  const api = browserLanguageModel();
  if (api === undefined) {
    return { status: "fallback", reason: "unsupported", stage: "capability" };
  }

  let availability: string;
  try {
    availability = await api.availability();
  } catch {
    return { status: "fallback", reason: "runtime_error", stage: "availability" };
  }
  if (availability !== "available") {
    return {
      status: "fallback",
      reason: "not_ready",
      stage: "availability",
      availability,
    };
  }

  let session: BrowserLanguageModelSession;
  try {
    session = await api.create({
      initialPrompts: [{ role: "system", content: systemPrompt }],
    });
  } catch {
    return { status: "fallback", reason: "runtime_error", stage: "create" };
  }

  try {
    const started = performance.now();
    const output = (await session.prompt(userPrompt)).trim();
    if (output.length === 0) {
      return { status: "fallback", reason: "runtime_error", stage: "prompt" };
    }
    return {
      status: "generated",
      text: output,
      runtime: "native",
      durationMs: performance.now() - started,
    };
  } catch {
    return { status: "fallback", reason: "runtime_error", stage: "prompt" };
  } finally {
    session.destroy?.();
  }
}

export function describeBrowserModelResult(result: BrowserModelResult): string {
  if (result.status === "generated") {
    const label = result.runtime === "webllm" ? "WebLLM" : "LanguageModel";
    return `${label} generated locally in ${result.durationMs.toFixed(1)} ms`;
  }
  const label = result.runtime === "webllm" ? "WebLLM" : "LanguageModel";
  if (result.reason === "unsupported") return `${label} API unsupported`;
  if (result.reason === "not_ready") {
    return `${label} ${result.availability ?? "not ready"}`;
  }
  return `${label} ${result.stage} failed`;
}

export async function loadWebLlm(
  onProgress: (progress: WebLlmProgress) => void,
): Promise<WebLlmLoadResult> {
  if (webLlmEngine !== null) {
    return { status: "ready", modelId: WEB_LLM_MODEL_ID, loadMs: 0 };
  }
  if (!("gpu" in navigator)) {
    return { status: "error", reason: "webgpu_unsupported" };
  }
  if (webLlmLoadPromise !== null) return webLlmLoadPromise;

  webLlmLoadPromise = (async () => {
    const started = performance.now();
    try {
      const webllm = await import("@mlc-ai/web-llm");
      webLlmEngine = await webllm.CreateMLCEngine(
        WEB_LLM_MODEL_ID,
        {
          initProgressCallback: (report: InitProgressReport) =>
            onProgress({ progress: report.progress, text: report.text }),
          logLevel: "WARN",
        },
        { context_window_size: 2048 },
      );
      return {
        status: "ready" as const,
        modelId: WEB_LLM_MODEL_ID,
        loadMs: performance.now() - started,
      };
    } catch {
      webLlmEngine = null;
      return { status: "error" as const, reason: "load_failed" as const };
    } finally {
      webLlmLoadPromise = null;
    }
  })();
  return webLlmLoadPromise;
}

export async function promptLoadedWebLlm(
  systemPrompt: string,
  userPrompt: string,
): Promise<BrowserModelResult> {
  return promptLoadedWebLlmRequest(systemPrompt, userPrompt);
}

export async function requestLoadedWebLlmToolCall(
  userPrompt: string,
  tool: ChatCompletionTool,
): Promise<BrowserToolCallResult> {
  if (webLlmEngine === null) {
    return {
      status: "fallback",
      reason: "not_ready",
      stage: "create",
      runtime: "webllm",
    };
  }
  const started = performance.now();
  try {
    await webLlmEngine.resetChat(false, WEB_LLM_MODEL_ID);
    const response = await webLlmEngine.chat.completions.create({
      messages: [{ role: "user", content: userPrompt }],
      tools: [tool],
      tool_choice: {
        type: "function",
        function: { name: tool.function.name },
      },
      temperature: 0,
      max_tokens: 256,
      seed: 1,
      stream: false,
    });
    const call = response.choices[0]?.message.tool_calls?.[0];
    if (!call) {
      return {
        status: "fallback",
        reason: "runtime_error",
        stage: "prompt",
        runtime: "webllm",
      };
    }
    return {
      status: "generated",
      call,
      raw: JSON.stringify(call, null, 2),
      runtime: "webllm",
      durationMs: performance.now() - started,
    };
  } catch {
    return {
      status: "fallback",
      reason: "runtime_error",
      stage: "prompt",
      runtime: "webllm",
    };
  }
}

async function promptLoadedWebLlmRequest(
  systemPrompt: string,
  userPrompt: string,
): Promise<BrowserModelResult> {
  if (webLlmEngine === null) {
    return {
      status: "fallback",
      reason: "not_ready",
      stage: "create",
      runtime: "webllm",
    };
  }
  const started = performance.now();
  try {
    await webLlmEngine.resetChat(false, WEB_LLM_MODEL_ID);
    const response = await webLlmEngine.chat.completions.create({
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0,
      max_tokens: 256,
      seed: 1,
      stream: false,
    });
    const output = response.choices[0]?.message.content?.trim();
    if (!output) {
      return {
        status: "fallback",
        reason: "runtime_error",
        stage: "prompt",
        runtime: "webllm",
      };
    }
    return {
      status: "generated",
      text: output,
      runtime: "webllm",
      durationMs: performance.now() - started,
    };
  } catch {
    return {
      status: "fallback",
      reason: "runtime_error",
      stage: "prompt",
      runtime: "webllm",
    };
  }
}
