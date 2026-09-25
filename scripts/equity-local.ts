import { monitorWithSecrets } from "../f/us-equity-monitor/analyze.ts";
import { createMonitorSecrets } from "../f/us-equity-monitor/secrets.ts";

if (process.argv.includes("--help")) {
  console.log("Usage: mise run equity:local -- [AAPL MSFT ...]\nSet PI_AUTH_JSON, FINNHUB_API_KEY, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env. Executes one research run and sends quotes and a short opinion to Telegram.");
  process.exit(0);
}
const symbols = process.argv.slice(2);
const result = await monitorWithSecrets(createMonitorSecrets(), {
  provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL,
  symbols: symbols.length ? symbols : undefined, horizon: process.env.EQUITY_HORIZON,
});
console.log(result.text);
console.log(`\nTelegram message: ${result.messageId}`);
