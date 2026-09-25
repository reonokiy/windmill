import type { StockInformation } from "../lib/finnhub.ts";

export function validateTelegram(botToken: string, chatId: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Missing or invalid Telegram bot token");
  if (!chatId.trim()) throw new Error("Missing Telegram chat ID");
}

export function formatMessage(symbols: string[], evidence: StockInformation[], opinion: string, now: string) {
  // Do not truncate away a risk or condition from an unexpectedly long answer.
  if (!opinion.trim() || opinion.length > 1000) throw new Error("Opinion must be 1–1000 characters; no message sent");
  const latest = [...evidence].reverse();
  const lines = symbols.map(symbol => {
    const item = latest.find(item => item.kind === "quote" && item.symbol === symbol);
    if (!item?.valid) return `${symbol}：行情无效`;
    const quote = item.data as { price: number; changePercent?: number; quoteTimestamp: number };
    const change = typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent)
      ? `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` : "涨跌未知";
    const timestamp = new Date(quote.quoteTimestamp * 1000).toISOString().replace("T", " ").replace(".000Z", "Z");
    return `${symbol} $${quote.price.toFixed(2)} ${change} · ${timestamp}${item.stale ? " [过期]" : ""}`;
  });
  const status = latest.find(item => item.kind === "market_status")?.data as { session?: unknown } | undefined;
  const session = typeof status?.session === "string" ? status.session.slice(0, 40) : "未知";
  const text = `美股行情 · ${now}\n市场：${session}\n${lines.join("\n")}\n\n简短意见：${opinion.trim()}\n\n行情来源：Finnhub；时间为 UTC 报价时间，实时性以数据源为准。`;
  if (text.length > 4096) throw new Error("Telegram message too long; no message sent");
  return text;
}

/** Plain text avoids model-generated Markdown parse failures. Never log token-bearing URLs. */
export async function sendTelegram(botToken: string, chatId: string, text: string, http: typeof fetch = fetch) {
  validateTelegram(botToken, chatId);
  if (!text.trim() || text.length > 4096) throw new Error("Invalid Telegram message length");
  let response: Response;
  try {
    response = await http(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
  } catch { throw new Error("Telegram request failed or timed out; delivery unknown, check chat before retrying"); }
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  let data: { ok?: boolean; result?: { message_id?: number } };
  try { data = await response.json(); } catch { throw new Error("Invalid Telegram response"); }
  if (data?.ok !== true || typeof data.result?.message_id !== "number") throw new Error("Telegram did not confirm delivery");
  return data.result.message_id;
}
