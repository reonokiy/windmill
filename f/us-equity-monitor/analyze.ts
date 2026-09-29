// package_json: us-equity-monitor
import { Agent, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { createMonitorCodex, createMonitorSecrets, type MonitorSecrets } from "./secrets.ts";
import { resolveAuth } from "./auth.ts";
import { gatewayProvider } from "../lib/codex.ts";
import { systemPrompt, researchPrompt, defaultHorizon } from "./prompt.ts";
import { createTools, defaultSymbols, normalizeSymbols, referenceSymbols } from "./tools.ts";
import { formatMessage, sendTelegram, validateTelegram } from "./telegram.ts";

const defaultModel = "gpt-6-luna";

export async function runResearch(options: {
  model: Model<Api>; apiKey: string; tools: AgentTool<any>[]; prompt: string;
  timeoutMs?: number; maxTurns?: number; streamFn?: StreamFn;
}) {
  const maxTurns = options.maxTurns ?? 100;
  let turns = 0;
  let limitReached = false;
  const agent = new Agent({
    initialState: { model: options.model, systemPrompt, tools: options.tools, thinkingLevel: "xhigh" },
    getApiKey: () => options.apiKey,
    streamFn: options.streamFn ?? ((model, context, opts) => streamSimple(model, context, {
      ...opts, maxTokens: 32_000,
    })),
    toolExecution: "sequential",
    maxRetryDelayMs: 5000,
  });
  agent.subscribe(event => {
    if (event.type === "turn_start" && ++turns > maxTurns) {
      limitReached = true;
      agent.abort();
    }
  });
  const timer = setTimeout(() => { limitReached = true; agent.abort(); }, options.timeoutMs ?? 600_000);
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
  provider: string = gatewayProvider,
  model: string = defaultModel,
  auth_secret: string = "u/reonokiy/us_equity_pi_auth",
  market_data_secret: string = "u/reonokiy/us_equity_finnhub_key",
  symbols: string[] = defaultSymbols,
  horizon: string = defaultHorizon,
  telegram_bot_secret: string = "u/reonokiy/us_equity_telegram_bot_token",
  telegram_chat_secret: string = "u/reonokiy/us_equity_telegram_chat_id",
  gateway_key_secret: string = "u/reonokiy/us_equity_gateway_key",
  telegram_thread_secret: string = "u/reonokiy/us_equity_telegram_thread_id",
) {
  const secrets = createMonitorSecrets({
    auth: auth_secret, gatewayKey: gateway_key_secret, finnhub: market_data_secret, telegramBot: telegram_bot_secret, telegramChat: telegram_chat_secret,
    telegramThread: telegram_thread_secret,
  });
  return monitorWithSecrets(secrets, { provider, model, symbols, horizon });
}

/** Both entrypoints use identical secret loading and notification logic. */
export async function monitorWithSecrets(secrets: MonitorSecrets, options: {
  provider?: string; model?: string; symbols?: string[]; horizon?: string;
} = {}) {
  const [token, botToken, chatId, thread] = await Promise.all([
    secrets.get("finnhub"), secrets.get("telegramBot"), secrets.get("telegramChat"), secrets.get("telegramThread"),
  ]);
  const threadId = Number(thread);
  validateTelegram(botToken, chatId, threadId);
  const provider = options.provider ?? gatewayProvider;
  const model = options.model ?? defaultModel;
  const resolved = provider === gatewayProvider
    ? await createMonitorCodex(secrets).model({ model, effort: "highest" })
    : await resolveAuth(provider, model, secrets);
  return analyzeAndNotify({ ...resolved, token, symbols: options.symbols, horizon: options.horizon, botToken, chatId, threadId });
}

/** Shared orchestration for Windmill and local Bun. No report storage. */
export async function analyzeAndNotify(options: {
  model: Model<Api>; apiKey: string; token: string; botToken: string; chatId: string;
  symbols?: string[]; horizon?: string; streamFn?: StreamFn; http?: typeof fetch;
  telegramHttp?: typeof fetch; threadId?: number;
}) {
  validateTelegram(options.botToken, options.chatId, options.threadId);
  const universe = normalizeSymbols(options.symbols ?? defaultSymbols);
  const horizon = options.horizon ?? defaultHorizon;
  if (!horizon.trim() || horizon.length > 500) throw new Error("Provide a research horizon of 1–500 characters");
  if (!options.token.trim()) throw new Error("Missing Finnhub API key");
  const startedAt = new Date().toISOString();
  const { tools, evidence } = createTools(options.token, universe, options.http);
  const result = await runResearch({ ...options, tools, prompt: researchPrompt(universe, horizon, startedAt) });
  if (!universe.every(symbol => evidence.some(item => item.kind === "quote" && item.symbol === symbol)) ||
      !universe.filter(symbol => !referenceSymbols.includes(symbol)).every(symbol =>
        evidence.some(item => item.kind === "news" && item.symbol === symbol))) {
    throw new Error("Agent did not obtain all quotes and news; no message sent");
  }
  const text = formatMessage(universe, evidence, result.opinion, startedAt);
  const messageId = await sendTelegram(options.botToken, options.chatId, text, options.telegramHttp, options.threadId);
  return { messageId, text };
}
