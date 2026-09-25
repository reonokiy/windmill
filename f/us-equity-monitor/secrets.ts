import { createSecrets } from "../lib/secrets.ts";

/** Only this application boundary knows variable names and environment variable names. */
export function createMonitorSecrets(paths: {
  auth?: string; finnhub?: string; telegramBot?: string; telegramChat?: string;
} = {}) {
  return createSecrets({
    auth: { windmill: paths.auth ?? "u/reonokiy/us_equity_pi_auth", env: "PI_AUTH_JSON" },
    finnhub: { windmill: paths.finnhub ?? "u/reonokiy/us_equity_finnhub_key", env: "FINNHUB_API_KEY" },
    telegramBot: { windmill: paths.telegramBot ?? "u/reonokiy/us_equity_telegram_bot_token", env: "TELEGRAM_BOT_TOKEN" },
    telegramChat: { windmill: paths.telegramChat ?? "u/reonokiy/us_equity_telegram_chat_id", env: "TELEGRAM_CHAT_ID" },
  });
}
export type MonitorSecrets = ReturnType<typeof createMonitorSecrets>;
