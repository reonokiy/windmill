import { expect, test } from "bun:test";
import { createSecrets } from "../f/lib/secrets.ts";
import { createCodexClient } from "../f/lib/codex.ts";

const secrets = createSecrets({ gatewayKey: { windmill: "unused", env: "KEY" } }, {
  env: { KEY: "synthetic-gateway-key" },
});

test("gateway Luna sends maximum catalog effort through the actual Responses transport", async () => {
  const catalog = (async (url, init) => {
    expect(String(url)).toBe("https://api.nokiy.net/codex/codex/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-gateway-key");
    return Response.json({ models: [{ slug: "gpt-6-luna", context_window: 272000,
      supported_reasoning_levels: [{ effort: "max" }, { effort: "high" }, { effort: "xhigh" }],
    }] });
  }) as typeof fetch;
  const client = createCodexClient(secrets, catalog);
  const resolved = await client.model({ model: "gpt-6-luna", effort: "highest" });
  const requests: Array<{ url: string; auth: string | null; body: any }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push({ url: request.url, auth: request.headers.get("Authorization"), body: await request.json() });
    const item = { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
    const events = [
      { type: "response.output_item.added", item: { ...item, content: [] } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id: "resp_test", status: "completed" } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  } });
  try {
    const selectedModel = { ...resolved.model, baseUrl: `${server.url}codex/v1` };
    const context = { messages: [{ role: "user" as const, content: "test", timestamp: Date.now() }] };
    const result = await (await resolved.streamFn(selectedModel, context, {
      reasoning: "low", maxTokens: 1200, temperature: 0.5, signal: AbortSignal.timeout(5000),
    })).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/codex/v1/responses");
    expect(requests[0].auth).toBe("Bearer synthetic-gateway-key");
    expect(requests[0].body.model).toBe("gpt-6-luna");
    expect(requests[0].body.reasoning.effort).toBe("max");
    expect(requests[0].body.store).toBe(false);
    expect(requests[0].body.max_output_tokens).toBeUndefined();
    expect(requests[0].body.temperature).toBeUndefined();
    const high = await client.model({ model: "gpt-6-luna", effort: "high", reasoningSummary: "concise" });
    await (await high.streamFn({ ...high.model, baseUrl: selectedModel.baseUrl }, context)).result();
    expect(requests[1].body.reasoning).toEqual({ effort: "high", summary: "concise" });
    await expect(client.model({ model: "gpt-6-luna", effort: "ultra" })).rejects.toThrow("does not support");
    const internal = await createCodexClient({ ...secrets, get: async () => { throw new Error("must not read a key"); } },
      (async (_url, init) => {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Response.json({ models: [{ slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "max" }] }] });
      }) as typeof fetch, { WM_JOB_ID: "test-job" },
    ).model({ model: "gpt-6-luna" });
    await (await internal.streamFn({ ...internal.model, baseUrl: selectedModel.baseUrl }, context)).result();
    expect(requests[2].auth).toBeNull();
    expect(requests[2].body.reasoning.effort).toBe("max");
  } finally { server.stop(true); }
});

test("gateway catalog failures do not fall back or expose credentials or response bodies", async () => {
  await expect(createCodexClient(secrets,
    (async () => new Response("private-body", { status: 401 })) as unknown as typeof fetch,
  ).model({ model: "gpt-6-luna" })).rejects.toThrow("Codex gateway model catalog returned HTTP 401");
  await expect(createCodexClient(secrets,
    (async () => Response.json({ models: [] })) as unknown as typeof fetch,
  ).model({ model: "gpt-6-luna" })).rejects.toThrow("absent");
});
