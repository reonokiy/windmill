import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { analyzeAndNotify, runResearch } from "../f/us-equity-monitor/analyze.ts";
import { createTools, normalizeSymbols } from "../f/us-equity-monitor/tools.ts";

const model = getModel("openai-codex", "gpt-5.3-codex");
function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    events.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    events.push({ type: "done", reason: message.stopReason, message });
  }
  return events;
}


describe("equity research", () => {
  test("fetches on demand then sends quotes and a short opinion in one Telegram message", async () => {
    let requests = 0;
    let calls = 0;
    const http = (async (url: URL) => {
      requests++;
      return Response.json(url.pathname.endsWith("/quote") ? { c: 123, t: Math.floor(Date.now() / 1000) } : [{ headline: "tool-only-news" }]);
    }) as unknown as typeof fetch;
    const streamFn: StreamFn = (_model, context) => {
      if (++calls === 1) {
        expect(requests).toBe(0);
        expect(JSON.stringify(context)).not.toContain("tool-only-news");
        return stream(response([
          { type: "toolCall", id: "quote", name: "query_stock", arguments: { kind: "quote", symbol: "AAPL" } },
          { type: "toolCall", id: "news", name: "query_stock", arguments: { kind: "news", symbol: "AAPL" } },
        ], "toolUse"));
      }
      expect(requests).toBe(2);
      expect(JSON.stringify(context.messages)).toContain("tool-only-news");
      return stream(response([{ type: "text", text: "研究完成" }], "stop"));
    };
    const sent: string[] = [];
    const telegramHttp = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe("123");
      expect(body.parse_mode).toBeUndefined();
      sent.push(body.text);
      return Response.json({ ok: true, result: { message_id: 42 } });
    }) as typeof fetch;
    const result = await analyzeAndNotify({ model, apiKey: "test", botToken: "123:test", chatId: "123", token: "test", symbols: ["AAPL"], http, streamFn, telegramHttp });
    expect(sent).toEqual([result.text]);
    expect(result.text).toContain("AAPL $123.00");
    expect(result.text).toContain("研究完成");
    expect(result.messageId).toBe(42);
  });

  test("normalizes the bounded universe", () => {
    expect(normalizeSymbols([" aapl ", "AAPL", "BRK.B"])).toEqual(["AAPL", "BRK.B"]);
    expect(() => normalizeSymbols([])).toThrow();
    expect(() => normalizeSymbols(["AAPL&token=secret"])).toThrow();
  });

  test("quotes preserve timestamps, flag staleness, and do not expose the API key", async () => {
    const http = (async (url, init) => {
      expect(String(url)).not.toContain("private-key");
      expect(new Headers(init?.headers).get("X-Finnhub-Token")).toBe("private-key");
      return Response.json({ c: 123, t: 1 });
    }) as typeof fetch;
    const { tools, evidence } = createTools("private-key", ["AAPL"], http);
    const answer = await tools[0].execute("1", { kind: "quote", symbol: "AAPL" });
    const block = answer.content[0];
    expect(block.type === "text" && JSON.parse(block.text).stale).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("private-key");
    expect(evidence[0].retrievedAt).toBeDefined();
    await expect(tools[0].execute("2", { kind: "quote", symbol: "MSFT" })).rejects.toThrow("outside");
  });

  test("provider HTTP failures are tool errors", async () => {
    const { tools } = createTools("secret", ["AAPL"], (async () => new Response("secret body", { status: 429 })) as unknown as typeof fetch);
    await expect(tools[0].execute("1", { kind: "quote", symbol: "AAPL" })).rejects.toThrow("HTTP 429");
  });

  test("pi executes a custom tool and completes a second model turn", async () => {
    const { tools } = createTools("unused", ["AAPL"], (async () => Response.json({ session: "regular" })) as unknown as typeof fetch);
    let calls = 0;
    const streamFn: StreamFn = (_model, context) => {
      calls++;
      if (calls === 1) return stream(response([{ type: "toolCall", id: "previous", name: "query_stock", arguments: { kind: "market_status" } }], "toolUse"));
      expect(context.messages.some(message => message.role === "toolResult")).toBe(true);
      return stream(response([{ type: "text", text: "本轮无新信号" }], "stop"));
    };
    const result = await runResearch({ model, apiKey: "test", tools, prompt: "Research", streamFn });
    expect(result.opinion).toBe("本轮无新信号");
    expect(result.turns).toBe(2);
  });

  test("model failures and runaway loops do not return reports", async () => {
    await expect(runResearch({ model, apiKey: "test", tools: [], prompt: "Research",
      streamFn: () => stream(response([], "error")) })).rejects.toThrow("did not complete");
    const { tools } = createTools("unused", ["AAPL"], (async () => Response.json({ session: "regular" })) as unknown as typeof fetch);
    await expect(runResearch({ model, apiKey: "test", tools, prompt: "Research", maxTurns: 1,
      streamFn: (_model, _context, options) => stream(options?.signal?.aborted ? response([], "aborted") :
        response([{ type: "toolCall", id: "previous", name: "query_stock", arguments: { kind: "market_status" } }], "toolUse")) })).rejects.toThrow("limit");
  });

  test("timeout aborts an in-flight model request without publishing partial text", async () => {
    const streamFn: StreamFn = (_model, _context, options) => {
      const events = createAssistantMessageEventStream();
      const abort = () => events.push({ type: "error", reason: "aborted", error: response([{ type: "text", text: "partial" }], "aborted") });
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      return events;
    };
    await expect(runResearch({ model, apiKey: "test", tools: [], prompt: "Research", timeoutMs: 10, streamFn })).rejects.toThrow("limit");
  });
});

describe("Telegram delivery", () => {
  test("rejects tool-free answers before sending", async () => {
    let sent = false;
    await expect(analyzeAndNotify({ model, apiKey: "test", token: "test", botToken: "123:test", chatId: "123",
      symbols: ["AAPL"], streamFn: () => stream(response([{ type: "text", text: "观望" }], "stop")),
      telegramHttp: (async () => { sent = true; return Response.json({ ok: true }); }) as unknown as typeof fetch,
    })).rejects.toThrow("all quotes and news");
    expect(sent).toBe(false);
  });

  test("Telegram failures are sanitized and not retried", async () => {
    const { sendTelegram } = await import("../f/us-equity-monitor/telegram.ts");
    let calls = 0;
    await expect(sendTelegram("123:private", "123", "观望", (async () => {
      calls++; throw new Error("https://api.telegram.org/bot123:private/sendMessage");
    }) as unknown as typeof fetch)).rejects.toThrow("delivery unknown");
    expect(calls).toBe(1);
    await expect(sendTelegram("123:private", "123", "观望", (async () =>
      Response.json({ ok: false, description: "private" })) as unknown as typeof fetch)).rejects.toThrow("did not confirm");
    await expect(sendTelegram("123:private", "123", "观望", (async () =>
      new Response("private", { status: 429 })) as unknown as typeof fetch)).rejects.toThrow("HTTP 429");
  });

  test("message preserves quote age and rejects long opinions", async () => {
    const { formatMessage } = await import("../f/us-equity-monitor/telegram.ts");
    const evidence = [{ kind: "quote" as const, symbol: "AAPL", source: "test", retrievedAt: "now", valid: true,
      stale: true, data: { price: 123, changePercent: -1.2, quoteTimestamp: 1 } }];
    const text = formatMessage(["AAPL", "MSFT"], evidence, "数据不足，暂时观望", "now");
    expect(text).toContain("-1.20%");
    expect(text).toContain("1970-01-01");
    expect(text).toContain("[过期]");
    expect(text).toContain("MSFT：行情无效");
    expect(() => formatMessage(["AAPL"], evidence, "长".repeat(1001), "now")).toThrow("1000");
  });
});
