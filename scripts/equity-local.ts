import { monitorWithSecrets } from "../f/us-equity-monitor/analyze.ts";
import { createMonitorSecrets } from "../f/us-equity-monitor/secrets.ts";

if (process.argv.includes("--help")) {
  console.log("Usage: mise run equity:local -- [--windmill-secrets] [AAPL MSFT ...]\nDefault: read credentials from .env. --windmill-secrets: read business secrets from Windmill, read-only; requires WM_TOKEN, WM_WORKSPACE and BASE_INTERNAL_URL. CODEX_API_KEY always comes from local env. Executes one research run and sends a Telegram message. Use mise run equity:remote-secrets to inject Windmill credentials through OpenBao.");
  process.exit(0);
}
const remoteSecrets = process.argv.includes("--windmill-secrets");
const symbols = process.argv.slice(2).filter(arg => arg !== "--windmill-secrets");
const secrets = createMonitorSecrets({}, remoteSecrets ? { backend: "windmill-readonly" } : {});
const result = await monitorWithSecrets(secrets, {
  provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL,
  symbols: symbols.length ? symbols : undefined, horizon: process.env.EQUITY_HORIZON,
});
console.log(result.text);
console.log(`\nTelegram message: ${result.messageId}`);
