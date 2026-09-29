import type { StockInformation } from "../lib/finnhub.ts";
import { referenceSymbols } from "./tools.ts";

export function validateTelegram(botToken: string, chatId: string, threadId?: number) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Missing or invalid Telegram bot token");
  if (!chatId.trim()) throw new Error("Missing Telegram chat ID");
  if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
    throw new Error("Invalid Telegram topic ID");
  }
}

function displayTime(value: string | number) {
  return new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000)
    .toISOString().replace("T", " ").replace(".000Z", "").replace(/\.\d{3}Z$/, "");
}

export function formatMessage(symbols: string[], evidence: StockInformation[], opinion: string, now: string) {
  // Do not truncate away a risk or condition from an unexpectedly long answer.
  if (!opinion.trim() || opinion.length > 1000) throw new Error("Opinion must be 1–1000 characters; no message sent");
  const latest = [...evidence].reverse();
  const lines = symbols.map(symbol => {
    const item = latest.find(item => item.kind === "quote" && item.symbol === symbol);
    if (!item?.valid) return `${symbol}：行情无效`;
    const quote = item.data as { changePercent?: number; quoteTimestamp: number };
    const change = typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent)
      ? `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` : "涨跌未知";
    const timestamp = displayTime(quote.quoteTimestamp * 1000);
    return `${symbol} ${change} · ${timestamp}${item.stale ? " [过期]" : ""}`;
  });
  const status = latest.find(item => item.kind === "market_status")?.data as { session?: unknown } | undefined;
  const session = typeof status?.session === "string" ? status.session.slice(0, 40) : "未知";
  const indexes = lines.filter((_, i) => referenceSymbols.includes(symbols[i]));
  const stocks = lines.filter((_, i) => !referenceSymbols.includes(symbols[i]));
  const text = `科技/芯片超短线 · ${displayTime(now)}（UTC+8）\n市场：${session}\n\n${opinion.trim()}\n\n个股涨跌幅（较昨收）：\n${stocks.join("\n")}${indexes.length ? `\n\n指数参考（非交易标的）：\n${indexes.join("\n")}` : ""}`;
  if (text.length > 4096) throw new Error("Telegram message too long; no message sent");
  return text;
}

/** Plain text avoids model-generated Markdown parse failures. Never log token-bearing URLs. */
export async function sendTelegram(botToken: string, chatId: string, text: string, http: typeof fetch = fetch, threadId?: number) {
  validateTelegram(botToken, chatId, threadId);
  if (!text.trim() || text.length > 4096) throw new Error("Invalid Telegram message length");
  let response: Response;
  try {
    response = await http(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
  } catch { throw new Error("Telegram request failed or timed out; delivery unknown, check chat before retrying"); }
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  let data: { ok?: boolean; result?: { message_id?: number } };
  try { data = await response.json(); } catch { throw new Error("Invalid Telegram response"); }
  if (data?.ok !== true || typeof data.result?.message_id !== "number") throw new Error("Telegram did not confirm delivery");
  return data.result.message_id;
}
