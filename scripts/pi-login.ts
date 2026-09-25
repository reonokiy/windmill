import { createInterface } from "node:readline/promises";
import { open } from "node:fs/promises";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";

const providerId = process.argv[2] ?? "openai-codex";
const provider = getOAuthProvider(providerId);
if (!provider) throw new Error(`No pi OAuth login provider: ${providerId}`);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  const credentials = await provider.login({
    onAuth: info => { console.log(info.url); if (info.instructions) console.log(info.instructions); },
    onPrompt: prompt => terminal.question(`${prompt.message}: `),
  });
  // Refuse to replace a previous login; never print credentials to the terminal.
  const path = ".pi-auth.json";
  const file = await open(path, "wx", 0o600);
  try { await Bun.write(Bun.file(file.fd), JSON.stringify({ [providerId]: { type: "oauth", ...credentials } })); }
  catch (error) { await Bun.file(path).delete().catch(() => {}); throw error; }
  finally { await file.close(); }
  console.log("Saved .pi-auth.json. Set PI_AUTH_JSON to its JSON for local debugging, or import it into the Windmill secret. Credentials were not printed.");
} finally { terminal.close(); }
