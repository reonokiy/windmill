import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "bun:test";
import { createB2 } from "../f/lib/b2.ts";
import { createBlob } from "../f/lib/blob.ts";
import { verifyBlobRoundtrip } from "./helpers/blob.ts";

test("B2 round trips, content types, exact keys, and S3 errors", async () => {
  const objects = new Map<string, { body: Buffer; type: string | undefined }>();
  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, { body: Buffer.concat(chunks), type: req.headers["content-type"] });
      res.setHeader("ETag", '"test-etag"');
      res.end();
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else if (objects.has(key)) {
      res.end(objects.get(key)!.body);
    } else {
      const code = key.endsWith("denied") ? "AccessDenied" : "NoSuchKey";
      res.writeHead(code === "AccessDenied" ? 403 : 404, { "Content-Type": "application/xml" });
      res.end(`<Error><Code>${code}</Code><Message>Test error</Message></Error>`);
    }
  });
  // Local mock only; never use actual credentials or contact B2 in unit tests.
  const previous = { key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = "local-test";
  process.env.AWS_SECRET_ACCESS_KEY = "local-test";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const b2 = createB2({ bucket: "test-bucket", endPoint: "127.0.0.1", port: address.port, useSSL: false, region: "us-west-004" });
  try {
    const key = "reports/中文 +%.txt";
    const result = await b2.writeText(key, "你好 🌍");
    assert.equal(result, Buffer.byteLength("你好 🌍"));
    assert.equal(await b2.readText(key), "你好 🌍");
    assert.equal(objects.get(`/test-bucket/${key}`)?.type, "text/plain; charset=utf-8");
    await b2.writeJson("data.json", { count: 0, values: [false, null, "你好"] });
    assert.deepEqual(await b2.readJson("data.json"), { count: 0, values: [false, null, "你好"] });
    assert.equal(objects.get("/test-bucket/data.json")?.type, "application/json; charset=utf-8");
    await b2.write("binary", new Uint8Array([0, 255, 128]));
    assert.deepEqual(await b2.readBytes("binary"), new Uint8Array([0, 255, 128]));
    await b2.writeText("empty", "");
    assert.equal(await b2.readText("empty"), "");
    await b2.writeText("invalid.json", "invalid");
    await assert.rejects(b2.readJson("invalid.json"), SyntaxError);
    assert.throws(() => b2.writeJson("bad.json", undefined), TypeError);
    await assert.rejects(b2.readText(""), /must not be empty/);
    await b2.delete(key);
    await assert.rejects(b2.readText(key), { code: "NoSuchKey" });
    await assert.rejects(b2.readText("denied"), { code: "AccessDenied" });

    const config = { bucket: "test-bucket", endPoint: `http://127.0.0.1:${address.port}`, region: "test" };
    const first = await createBlob("daily-report", { backend: "b2", config });
    const second = await createBlob("feed-sync", { backend: "b2", config });
    const smoke = await verifyBlobRoundtrip(first);
    assert.equal(smoke.ok, true);
    assert.equal(smoke.cleanedUp, true);
    assert.equal([...objects.keys()].filter(key => key.startsWith("/test-bucket/apps/daily-report/tmp/")).length, 0);
    const cleanupPaths: string[] = [];
    await assert.rejects(verifyBlobRoundtrip({
      ...first,
      writeText: async () => { throw new Error("Simulated upload failure"); },
      delete: async path => { cleanupPaths.push(path); },
    }), AggregateError);
    assert.equal(cleanupPaths.length, 3);
    await first.writeJson("data/state.json", { app: "first" });
    await second.writeJson("data/state.json", { app: "second" });
    assert.equal(first.key("data/state.json"), "apps/daily-report/data/state.json");
    assert.ok(objects.has("/test-bucket/apps/daily-report/data/state.json"));
    assert.deepEqual(await first.readJson("data/state.json"), { app: "first" });
    assert.deepEqual(await second.readJson("data/state.json"), { app: "second" });
    await first.delete("data/state.json");
    await assert.rejects(first.readJson("data/state.json"), { code: "NoSuchKey" });
    assert.deepEqual(await second.readJson("data/state.json"), { app: "second" });
    for (const path of ["", "/other/file", "../other/file", "a/../file", "./file", "a//file", "a/", "a\\file", "a\u0000file"]) {
      assert.throws(() => first.writeText(path, "bad"), /must be relative/);
      assert.throws(() => first.readText(path), /must be relative/);
      assert.throws(() => first.delete(path), /must be relative/);
    }
    for (const app of ["", "lib", "../other", "MyApp", "app_name", "app--name"]) {
      await assert.rejects(createBlob(app, { backend: "b2", config }), /App ID/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous.key === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previous.key;
    if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
  }
});

test("rejects incomplete resource configuration", () => {
  assert.throws(() => createB2({ bucket: "", endPoint: "s3.example.com", region: "test" }), /requires bucket/);
  assert.throws(() => createB2({ bucket: "test", endPoint: "ftp://example.com", region: "test" }), /HTTP/);
});
