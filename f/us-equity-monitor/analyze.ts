// Pin pi-ai's optional Mistral provider to a release without the optional OpenTelemetry peer.
if (process.env.WM_JOB_ID) {
  // @ts-ignore Windmill resolves versioned npm specifiers in Bun scripts.
  await import("@mistralai/mistralai@2.2.0");
}
import { Agent, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { createMonitorSecrets, type MonitorSecrets } from "./secrets.ts";
import { resolveAuth } from "./auth.ts";
import { systemPrompt, researchPrompt } from "./prompt.ts";
import { createTools, defaultSymbols, normalizeSymbols } from "./tools.ts";
import { formatMessage, sendTelegram, validateTelegram } from "./telegram.ts";

export async function runResearch(options: {
  model: Model<Api>; apiKey: string; tools: AgentTool<any>[]; prompt: string;
  timeoutMs?: number; maxTurns?: number; streamFn?: StreamFn;
}) {
  const maxTurns = options.maxTurns ?? 12;
  let turns = 0;
  let limitReached = false;
  const agent = new Agent({
    initialState: { model: options.model, systemPrompt, tools: options.tools, thinkingLevel: "low" },
    getApiKey: () => options.apiKey,
    streamFn: options.streamFn ?? ((model, context, opts) => streamSimple(model, context, { ...opts, maxTokens: 1200 })),
    toolExecution: "sequential",
    maxRetryDelayMs: 5000,
  });
  agent.subscribe(event => {
    if (event.type === "turn_start" && ++turns > maxTurns) {
      limitReached = true;
      agent.abort();
    }
  });
  const timer = setTimeout(() => { limitReached = true; agent.abort(); }, options.timeoutMs ?? 240_000);
  try {
    await agent.prompt(options.prompt);
    if (limitReached) throw new Error("Research exceeded the time or turn limit; no message sent");
    const last = agent.state.messages.at(-1);
    if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
      throw new Error("Research did not complete successfully; no message sent");
    }
    const opinion = last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim();
    if (!opinion) throw new Error("Agent returned an empty opinion");
    const usage = agent.state.messages.flatMap(message => message.role === "assistant" ? [message.usage] : []);
    return { opinion, turns, usage };
  } finally { clearTimeout(timer); }
}

export async function main(
  provider: string = "openai-codex",
  model: string = "gpt-5.3-codex",
  auth_secret: string = "u/reonokiy/us_equity_pi_auth",
  market_data_secret: string = "u/reonokiy/us_equity_finnhub_key",
  symbols: string[] = defaultSymbols,
  horizon: string = "未来几天到几周",
  telegram_bot_secret: string = "u/reonokiy/us_equity_telegram_bot_token",
  telegram_chat_secret: string = "u/reonokiy/us_equity_telegram_chat_id",
) {
  const secrets = createMonitorSecrets({
    auth: auth_secret, finnhub: market_data_secret, telegramBot: telegram_bot_secret, telegramChat: telegram_chat_secret,
  });
  return monitorWithSecrets(secrets, { provider, model, symbols, horizon });
}

/** Both entrypoints use identical secret loading, OAuth refresh and notification logic. */
export async function monitorWithSecrets(secrets: MonitorSecrets, options: {
  provider?: string; model?: string; symbols?: string[]; horizon?: string;
} = {}) {
  const [token, botToken, chatId] = await Promise.all([
    secrets.get("finnhub"), secrets.get("telegramBot"), secrets.get("telegramChat"),
  ]);
  validateTelegram(botToken, chatId);
  const resolved = await resolveAuth(options.provider ?? "openai-codex", options.model ?? "gpt-5.3-codex", secrets);
  return analyzeAndNotify({ ...resolved, token, symbols: options.symbols, horizon: options.horizon, botToken, chatId });
}

/** Shared orchestration for Windmill and local Bun. No report storage. */
export async function analyzeAndNotify(options: {
  model: Model<Api>; apiKey: string; token: string; botToken: string; chatId: string;
  symbols?: string[]; horizon?: string; streamFn?: StreamFn; http?: typeof fetch;
  telegramHttp?: typeof fetch;
}) {
  validateTelegram(options.botToken, options.chatId);
  const universe = normalizeSymbols(options.symbols ?? defaultSymbols);
  const horizon = options.horizon ?? "未来几天到几周";
  if (!horizon.trim() || horizon.length > 500) throw new Error("Provide a research horizon of 1–500 characters");
  if (!options.token.trim()) throw new Error("Missing Finnhub API key");
  const startedAt = new Date().toISOString();
  const { tools, evidence } = createTools(options.token, universe, options.http);
  const result = await runResearch({ ...options, tools, prompt: researchPrompt(universe, horizon, startedAt) });
  if (!universe.every(symbol => evidence.some(item => item.kind === "quote" && item.symbol === symbol)) ||
      !evidence.some(item => item.kind === "news")) {
    throw new Error("Agent did not obtain all quotes and news; no message sent");
  }
  const text = formatMessage(universe, evidence, result.opinion, startedAt);
  const messageId = await sendTelegram(options.botToken, options.chatId, text, options.telegramHttp);
  return { messageId, text };
}
