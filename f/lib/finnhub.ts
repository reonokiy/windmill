/** Finnhub quote, company-news, and US market-status queries. */
export type StockQuery = { kind: "quote" | "news"; symbol: string } | { kind: "market_status" };
export interface StockInformation {
  kind: StockQuery["kind"];
  symbol?: string;
  source: string;
  retrievedAt: string;
  data: unknown;
  valid?: boolean;
  stale?: boolean;
}

export function parseStockQuery(args: unknown): StockQuery {
  if (!args || typeof args !== "object" || !("kind" in args)) throw new Error("Missing query kind");
  if (args.kind === "market_status") return { kind: args.kind };
  if (args.kind !== "quote" && args.kind !== "news") throw new Error("Unsupported stock query kind");
  if (!("symbol" in args) || typeof args.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(args.symbol)) throw new Error("Provide a valid stock symbol");
  return { kind: args.kind, symbol: args.symbol };
}

/** No model, Windmill, or storage dependency; also callable from ordinary code. */
export function createStockQuery(token: string, http: typeof fetch = fetch) {
  return async (input: StockQuery, signal?: AbortSignal): Promise<StockInformation> => {
    const query = parseStockQuery(input);
    const endpoint = { quote: "quote", news: "company-news", market_status: "stock/market-status" }[query.kind];
    const url = new URL(`https://finnhub.io/api/v1/${endpoint}`);
    if (query.kind === "market_status") url.searchParams.set("exchange", "US");
    else url.searchParams.set("symbol", query.symbol);
    if (query.kind === "news") {
      url.searchParams.set("from", new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10));
      url.searchParams.set("to", new Date().toISOString().slice(0, 10));
    }
    let response: Response;
    try {
      response = await http(url, {
        headers: { "X-Finnhub-Token": token },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
    } catch { throw new Error("Market data request failed or timed out"); }
    if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || "error" in raw) throw new Error("Invalid market data response");
    const item: StockInformation = { kind: query.kind, source: url.toString(), retrievedAt: new Date().toISOString(), data: raw };
    if (query.kind !== "market_status") item.symbol = query.symbol;
    if (query.kind === "news") {
      if (!Array.isArray(raw)) throw new Error("Invalid company news response");
      item.data = raw.slice(0, 15);
    }
    if (query.kind === "quote") {
      const quote = raw as { c?: number; pc?: number; t?: number; d?: number; dp?: number };
      item.valid = typeof quote.c === "number" && Number.isFinite(quote.c) && quote.c > 0 && typeof quote.t === "number" && Number.isFinite(quote.t) && quote.t > 0;
      item.stale = !item.valid || Date.now() / 1000 - quote.t! > 900 || quote.t! > Date.now() / 1000 + 60;
      item.data = { price: quote.c, previousClose: quote.pc, change: quote.d, changePercent: quote.dp, quoteTimestamp: quote.t,
        note: "Unix quote timestamp; older than 15 minutes is stale. Feed latency is not independently verified." };
    }
    return item;
  };
}
