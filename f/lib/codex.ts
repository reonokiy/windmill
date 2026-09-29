import type { Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "@mariozechner/pi-ai/openai-responses";
import type { SecretStore } from "./secrets.ts";

export const gatewayBaseUrl = "https://api.nokiy.net/codex/v1";
export const gatewayProvider = "codex-gateway";
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = typeof efforts[number];
export interface CodexModelOptions {
  model: string;
  /** highest follows the selected model's catalog; explicit levels never downgrade. */
  effort?: CodexEffort | "highest";
  reasoningSummary?: OpenAIResponsesOptions["reasoningSummary"];
  timeoutMs?: number;
  maxRetries?: number;
}

/** Bind credentials once in the application's secrets.ts; callers only select model/options. */
export function createCodexClient(
  secrets?: SecretStore<"gatewayKey">,
  http: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
) {
  return { model: (options: CodexModelOptions) => resolveModel(secrets, options, http, !!env.WM_JOB_ID?.trim()) };
}

/** Read the gateway's native catalog so maximum effort is never silently downgraded. */
async function resolveModel(
  secrets: SecretStore<"gatewayKey"> | undefined,
  options: CodexModelOptions,
  http: typeof fetch,
  internal: boolean,
) {
  const modelId = options.model;
  if (!internal && !secrets) throw new Error("Local Codex calls require a gatewayKey SecretStore binding");
  // The SDK requires a nonempty key even without auth. This placeholder is never sent.
  const apiKey = internal ? "windmill-internal" : await secrets!.get("gatewayKey");
  let response: Response;
  try {
    response = await http(new URL("../codex/models", `${gatewayBaseUrl}/`), {
      headers: internal ? undefined : { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("Could not reach the Codex gateway model catalog"); }
  if (!response.ok) throw new Error(`Codex gateway model catalog returned HTTP ${response.status}`);
  let catalog: { models?: Array<{
    slug: string; context_window?: number; supported_reasoning_levels?: Array<{ effort: string }>;
  }> };
  try { catalog = await response.json(); }
  catch { throw new Error("Codex gateway returned an invalid model catalog"); }
  const entry = catalog.models?.find(item => item.slug === modelId);
  if (!entry) throw new Error(`Model ${modelId} is absent from the Codex gateway catalog`);
  const supported = entry.supported_reasoning_levels?.map(level => level.effort) ?? [];
  const requested = options.effort ?? "highest";
  const effort = requested === "highest"
    ? [...efforts].reverse().find(level => supported.includes(level)) : requested;
  if (!effort || !supported.includes(effort)) {
    throw new Error(`Model ${modelId} does not support reasoning effort ${requested}`);
  }
  const model: Model<"openai-responses"> = {
    id: modelId, name: modelId, provider: gatewayProvider, api: "openai-responses",
    baseUrl: gatewayBaseUrl, reasoning: true, thinkingLevelMap: { xhigh: effort },
    input: ["text"], contextWindow: entry.context_window ?? 128_000, maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const streamFn: StreamFn = (selectedModel, context, streamOptions) => {
    if (selectedModel.api !== "openai-responses" || selectedModel.provider !== gatewayProvider) {
      throw new Error("Codex client requires its gateway model");
    }
    return streamOpenAIResponses(selectedModel as Model<"openai-responses">, context, {
      signal: streamOptions?.signal, sessionId: streamOptions?.sessionId, apiKey,
      // OpenAI SDK accepts null to remove a default header; pi's header type is narrower.
      headers: internal ? { Authorization: null } as unknown as Record<string, string> : undefined,
      // pi's highest named level is xhigh; the model map carries max/ultra unchanged.
      reasoningEffort: "xhigh", reasoningSummary: options.reasoningSummary,
      // The gateway rejects temperature/max_output_tokens; upstream owns the budget.
      maxTokens: 0, timeoutMs: options.timeoutMs, maxRetries: options.maxRetries ?? 0,
    });
  };
  return { model, apiKey, streamFn, effort };
}
