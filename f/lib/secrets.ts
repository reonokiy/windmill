export type SecretBinding = { windmill: string; env: string };
export type SecretsBackend = "local" | "windmill";
export interface SecretStore<Name extends string = string> {
  readonly writable: boolean;
  get(name: Name): Promise<string>;
  getJson<T = unknown>(name: Name): Promise<T>;
  set(name: Name, value: string): Promise<void>;
  setJson(name: Name, value: unknown): Promise<void>;
}
type WindmillClient = Pick<typeof import("windmill-client"), "getVariable" | "setVariable">;

/** Automatically read local env or Windmill secrets; remote failures never fall back locally. */
export function createSecrets<const Bindings extends Record<string, SecretBinding>>(
  bindings: Bindings,
  options: { backend?: SecretsBackend; env?: Record<string, string | undefined>; windmill?: WindmillClient } = {},
): SecretStore<Extract<keyof Bindings, string>> {
  type Name = Extract<keyof Bindings, string>;
  const env = options.env ?? process.env;
  const backend = options.backend ?? (env.WM_JOB_ID?.trim() ? "windmill" : "local");
  function binding(name: Name) {
    if (!Object.hasOwn(bindings, name)) throw new Error(`Unknown secret: ${name}`);
    return bindings[name]!;
  }
  async function get(name: Name): Promise<string> {
    const entry = binding(name);
    let value: string | undefined;
    try {
      if (backend === "windmill") {
        const sdk = options.windmill ?? await import("windmill-client");
        value = await sdk.getVariable(entry.windmill);
      } else value = env[entry.env];
    } catch { throw new Error(`Could not read secret: ${name} (${backend})`); }
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing secret: ${name} (${backend})`);
    return value;
  }
  async function set(name: Name, value: string) {
    const entry = binding(name);
    if (backend === "local") throw new Error(`Secret is read-only in local environment: ${name}`);
    if (!value.trim()) throw new Error(`Secret must not be empty: ${name}`);
    try {
      const sdk = options.windmill ?? await import("windmill-client");
      await sdk.setVariable(entry.windmill, value, true);
    } catch { throw new Error(`Could not save secret: ${name} (${backend})`); }
  }
  return {
    get, set, writable: backend === "windmill",
    async getJson<T = unknown>(name: Name): Promise<T> {
      const value = await get(name);
      try { return JSON.parse(value) as T; }
      catch { throw new Error(`Secret is not valid JSON: ${name}`); }
    },
    async setJson(name: Name, value: unknown) {
      let text: string | undefined;
      try { text = JSON.stringify(value); } catch { throw new Error(`Secret is not serializable JSON: ${name}`); }
      if (text === undefined) throw new Error(`Secret is not serializable JSON: ${name}`);
      await set(name, text);
    },
  };
}
