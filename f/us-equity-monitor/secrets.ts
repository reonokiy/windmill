import { createSecrets, type SecretsOptions } from "../lib/secrets.ts";
import { createCodexClient } from "../lib/codex.ts";

/** Only this application boundary knows variable names and environment variable names. */
export function createMonitorSecrets(paths: {
  auth?: string; gatewayKey?: string; finnhub?: string; telegramBot?: string; telegramChat?: string; telegramThread?: string;
} = {}, options: SecretsOptions = {}) {
  return createSecrets({
    gatewayKey: { windmill: paths.gatewayKey ?? "u/reonokiy/us_equity_gateway_key", env: "CODEX_API_KEY" },
    auth: { windmill: paths.auth ?? "u/reonokiy/us_equity_pi_auth", env: "PI_AUTH_JSON" },
    finnhub: { windmill: paths.finnhub ?? "u/reonokiy/us_equity_finnhub_key", env: "FINNHUB_API_KEY" },
    telegramBot: { windmill: paths.telegramBot ?? "u/reonokiy/us_equity_telegram_bot_token", env: "TELEGRAM_BOT_TOKEN" },
    telegramChat: { windmill: paths.telegramChat ?? "u/reonokiy/us_equity_telegram_chat_id", env: "TELEGRAM_CHAT_ID" },
    telegramThread: { windmill: paths.telegramThread ?? "u/reonokiy/us_equity_telegram_thread_id", env: "TELEGRAM_THREAD_ID" },
  }, options);
}
export type MonitorSecrets = ReturnType<typeof createMonitorSecrets>;

export function createMonitorCodex(secrets = createMonitorSecrets()) {
  // Local model calls use the public gateway even when business secrets are read remotely.
  return createCodexClient(process.env.WM_JOB_ID?.trim()
    ? secrets : createMonitorSecrets({}, { backend: "local" }));
}
