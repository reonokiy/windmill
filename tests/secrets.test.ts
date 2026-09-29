import { expect, test } from "bun:test";
import { createSecrets } from "../f/lib/secrets.ts";
import { resolveAuth } from "../f/us-equity-monitor/auth.ts";

const bindings = {
  key: { windmill: "u/test/key", env: "API_KEY" },
  auth: { windmill: "u/test/auth", env: "PI_AUTH_JSON" },
};

test("local secrets automatically read env and reject all writes without mutation", async () => {
  const env = Object.freeze({ API_KEY: "local-value", PI_AUTH_JSON: '{"version":1}', WM_TOKEN: "cli-token", WM_WORKSPACE: "test" });
  const secrets = createSecrets(bindings, { env });
  expect(secrets.writable).toBe(false);
  expect(await secrets.get("key")).toBe("local-value");
  expect(await secrets.getJson<{ version: number }>("auth")).toEqual({ version: 1 });
  await expect(secrets.set("key", "changed")).rejects.toThrow("read-only");
  await expect(secrets.setJson("auth", { version: 2 })).rejects.toThrow("read-only");
  expect(env.API_KEY).toBe("local-value");
  expect(env.PI_AUTH_JSON).toBe('{"version":1}');
});

test("local OAuth and API-key credentials use env without refresh or persistence", async () => {
  const secrets = createSecrets(bindings, { env: Object.freeze({ PI_AUTH_JSON: JSON.stringify({
    "openai-codex": { type: "api_key", key: "synthetic-key" },
  }) }) });
  expect((await resolveAuth("openai-codex", "gpt-5.3-codex", secrets)).apiKey).toBe("synthetic-key");
  const oauth = (expires: number) => createSecrets(bindings, { env: Object.freeze({ PI_AUTH_JSON: JSON.stringify({
    "openai-codex": { access: "synthetic-access", refresh: "synthetic-refresh", expires },
  }) }) });
  expect((await resolveAuth("openai-codex", "gpt-5.3-codex", oauth(Date.now() + 60_000))).apiKey).toBe("synthetic-access");
  await expect(resolveAuth("openai-codex", "gpt-5.3-codex", oauth(1))).rejects.toThrow("expired");
});

test("Windmill jobs automatically use secret variables and ignore local values", async () => {
  let value = "remote";
  const secrets = createSecrets(bindings, {
    env: { WM_JOB_ID: "job", API_KEY: "local" },
    windmill: {
      async getVariable(path) { expect(path).toBe("u/test/key"); return value; },
      async setVariable(path, updated, isSecret) { expect(path).toBe("u/test/key"); expect(isSecret).toBe(true); value = updated; },
    },
  });
  expect(secrets.writable).toBe(true);
  expect(await secrets.get("key")).toBe("remote");
  await secrets.setJson("key", { rotated: true });
  expect(await secrets.getJson<{ rotated: boolean }>("key")).toEqual({ rotated: true });
  const failed = createSecrets(bindings, {
    env: { WM_JOB_ID: "job", API_KEY: "must-not-fallback" },
    windmill: {
      async getVariable() { throw new Error("private-secret-value"); },
      async setVariable() { throw new Error("private-secret-value"); },
    },
  });
  await expect(failed.get("key")).rejects.toEqual(new Error("Could not read secret: key (windmill)"));
  await expect(failed.set("key", "secret")).rejects.toEqual(new Error("Could not save secret: key (windmill)"));
});

test("missing, unknown and malformed secrets fail without leaking values", async () => {
  const secrets = createSecrets(bindings, { env: { PI_AUTH_JSON: '{"private-secret-value":broken' } });
  await expect(secrets.get("key")).rejects.toThrow("Missing secret");
  await expect(secrets.get("unbound" as "key")).rejects.toThrow("Unknown secret");
  await expect(secrets.getJson("auth")).rejects.toEqual(new Error("Secret is not valid JSON: auth"));
});

test("explicit remote reads use their own connection, never write or fall back locally", async () => {
  const requests: string[] = [];
  let fail = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    requests.push(request.method);
    expect(new URL(request.url).pathname).toBe("/api/w/test/variables/get/u/test/key");
    expect(new URL(request.url).searchParams.get("decrypt_secret")).toBe("true");
    expect(request.headers.get("Authorization")).toBe("Bearer synthetic-token");
    return fail ? new Response("private response body", { status: 403 }) : Response.json({ value: "remote-value" });
  } });
  const env = Object.freeze({ BASE_INTERNAL_URL: server.url.toString(), WM_WORKSPACE: "test",
    WM_TOKEN: "synthetic-token", API_KEY: "must-not-fallback" });
  const secrets = createSecrets(bindings, { backend: "windmill-readonly", env });
  try {
    expect(secrets.writable).toBe(false);
    expect(await secrets.get("key")).toBe("remote-value");
    await expect(secrets.set("key", "new-value")).rejects.toThrow("read-only");
    await expect(secrets.setJson("key", { changed: true })).rejects.toThrow("read-only");
    expect(requests).toEqual(["GET"]);
    fail = true;
    await expect(secrets.get("key")).rejects.toEqual(new Error("Could not read secret: key (windmill-readonly)"));
    expect(env.API_KEY).toBe("must-not-fallback");
    const unconfigured = createSecrets(bindings, { backend: "windmill-readonly", env: { API_KEY: "must-not-fallback" } });
    await expect(unconfigured.get("key")).rejects.toThrow("Could not read secret");
    expect(requests).toEqual(["GET", "GET"]);
  } finally { server.stop(true); }
});
