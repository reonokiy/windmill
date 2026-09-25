import { getModels, getProviders, type KnownProvider, type Model, type Api } from "@mariozechner/pi-ai";
import { getOAuthApiKey, getOAuthProvider, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { SecretStore } from "../lib/secrets.ts";

type Credential = OAuthCredentials | { type: "api_key"; key: string };
export type AuthStore = Record<string, Credential>;

// The secret is owned by this scheduled task. Do not share rotating OAuth tokens
// with another concurrently running agent or login installation.
export async function resolveAuth(provider: string, modelId: string, secrets: SecretStore<"auth">) {
  return resolveProviderAuth(provider, modelId, await secrets.getJson<AuthStore>("auth"),
    secrets.writable ? auth => secrets.setJson("auth", auth) : undefined);
}

export async function resolveProviderAuth(provider: string, modelId: string, auth: AuthStore, save?: (auth: AuthStore) => Promise<void>) {
  if (!getProviders().includes(provider as KnownProvider)) throw new Error(`Unknown pi provider: ${provider}`);
  const found = getModels(provider as KnownProvider).find(model => model.id === modelId);
  if (!found) throw new Error(`Unknown model ${modelId} for ${provider}; update the pinned pi packages if needed`);
  let model: Model<Api> = found;
  const credential = auth[provider];
  if (!credential) throw new Error(`Missing ${provider} credentials in the configured auth secret`);
  if ("key" in credential && credential.type === "api_key") {
    if (typeof credential.key !== "string" || !credential.key) throw new Error("Empty provider API key");
    return { model, apiKey: credential.key };
  }
  const oauth = credential as OAuthCredentials;
  if (!oauth.access || !oauth.refresh || !Number.isFinite(oauth.expires)) throw new Error("Invalid pi OAuth credentials");
  if (!save) {
    if (Date.now() >= oauth.expires) throw new Error("Local OAuth credentials expired; log in again and update PI_AUTH_JSON");
    const oauthProvider = getOAuthProvider(provider);
    if (!oauthProvider) throw new Error(`OAuth is unavailable for ${provider}`);
    model = oauthProvider.modifyModels?.([model], oauth)[0] ?? model;
    return { model, apiKey: oauthProvider.getApiKey(oauth) };
  }
  const result = await getOAuthApiKey(provider, { [provider]: oauth });
  if (!result) throw new Error(`OAuth is unavailable for ${provider}`);
  if (JSON.stringify(result.newCredentials) !== JSON.stringify(oauth)) {
    auth[provider] = result.newCredentials;
    // Persist token rotation before inference, even if inference subsequently fails.
    await save(auth);
  }
  model = getOAuthProvider(provider)?.modifyModels?.([model], result.newCredentials)[0] ?? model;
  return { model, apiKey: result.apiKey };
}
