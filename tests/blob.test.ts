import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBlob, createWindmillBackend, scopeBlob, withBlob } from "../f/lib/blob.ts";
import { verifyBlobRoundtrip } from "./helpers/blob.ts";

test("local backend shares the blob contract, isolates apps, and blocks traversal/symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "windmill-blob-"));
  const outside = await mkdtemp(join(tmpdir(), "windmill-outside-"));
  try {
    const first = await createBlob("first-app", { backend: "local", root });
    const second = await createBlob("second-app", { backend: "local", root });
    expect((await verifyBlobRoundtrip(first)).ok).toBe(true);
    expect(await first.writeText("data/中文.txt", "你好 🌍")).toBe(Buffer.byteLength("你好 🌍"));
    await second.writeText("data/中文.txt", "separate");
    expect(await first.readText("data/中文.txt")).toBe("你好 🌍");
    expect(await second.readText("data/中文.txt")).toBe("separate");
    expect(await Bun.file(join(root, first.key("data/中文.txt"))).text()).toBe("你好 🌍");
    await first.writeText("data/empty", "");
    expect(await first.readText("data/empty")).toBe("");
    await first.delete("data/missing");
    await expect(first.readText("data/missing")).rejects.toMatchObject({ code: "NoSuchKey" });
    await first.writeText("data/invalid", "invalid");
    await expect(first.readJson("data/invalid")).rejects.toBeInstanceOf(SyntaxError);
    expect(() => first.writeJson("data/bad", undefined)).toThrow(TypeError);
    for (const path of ["../second-app/x", "/etc/passwd", "a//b", "a/../b", "a\\b"]) {
      expect(() => first.writeText(path, "bad")).toThrow("relative");
    }
    await symlink(outside, join(root, "apps/first-app/escape"));
    await expect(first.writeText("escape/file", "bad")).rejects.toThrow("symlinks");
    await symlink(join(root, "apps/second-app/data/中文.txt"), join(root, "apps/first-app/data/link"));
    await expect(first.readText("data/link")).rejects.toMatchObject({ code: "ELOOP" });
    // Atomic replacement never follows a final-component symlink.
    await first.writeText("data/link", "own");
    expect(await second.readText("data/中文.txt")).toBe("separate");
    expect(await withBlob("first-app", blob => blob.readText("data/link"), { backend: "local", root })).toBe("own");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("Windmill adapter keeps the same storage and exact key across text, JSON, binary and delete", async () => {
  const objects = new Map<string, Uint8Array>();
  const types = new Map<string, string | undefined>();
  const adapter = await createWindmillBackend("archive", {
    async writeS3File(object, body, resource, contentType) {
      expect(resource).toBeUndefined();
      if (!object || typeof object === "string") throw new Error("Expected object descriptor");
      expect(object.storage).toBe("archive");
      objects.set(object.s3, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(await body.arrayBuffer()));
      types.set(object.s3, contentType);
      return object;
    },
    async loadS3File(object) {
      if (typeof object === "string") throw new Error("Expected object descriptor");
      expect(object.storage).toBe("archive");
      if (object.s3.endsWith("denied")) throw new Error("AccessDenied");
      if (!objects.has(object.s3)) throw new Error("Failed to load S3 file: 404 Not Found - <Error><Code>NoSuchKey</Code></Error>");
      return objects.get(object.s3)!;
    },
    async deleteS3File(object) {
      if (typeof object === "string") throw new Error("Expected object descriptor");
      expect(object.storage).toBe("archive");
      objects.delete(object.s3);
    },
  });
  const blob = scopeBlob("test-app", adapter);
  expect((await verifyBlobRoundtrip(blob)).ok).toBe(true);
  expect(objects.size).toBe(0);
  expect([...types.values()]).toContain("application/json; charset=utf-8");
  expect([...types.values()]).toContain("text/plain; charset=utf-8");
  expect([...types.values()]).toContain("application/octet-stream");
  await expect(blob.readText("data/denied")).rejects.toThrow("AccessDenied");
  expect(() => blob.readBytes("../other")).toThrow("relative");
});

test("automatic configuration uses local disk outside jobs and B2 inside Windmill", async () => {
  const root = await mkdtemp(join(tmpdir(), "windmill-auto-blob-"));
  const objects = new Map<string, Uint8Array>();
  let resourceReads = 0;
  let denyResource = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request): Promise<Response> {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path === "/api/w/test/resources/get_value_interpolated/u/reonokiy/b2") {
        resourceReads++;
        if (denyResource) return new Response("Denied", { status: 403 });
        return Response.json({ bucket: "test-bucket", region: "test", endPoint: server.url.origin });
      }
      if (request.method === "PUT") {
        objects.set(path, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { headers: { ETag: '"test"' } });
      }
      if (request.method === "DELETE") { objects.delete(path); return new Response(null, { status: 204 }); }
      const body = objects.get(path);
      return body ? new Response(new Uint8Array(body)) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    },
  });
  const moduleUrl = new URL("../f/lib/blob.ts", import.meta.url).href;
  async function run(app: string, jobId: string) {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { withBlob } from ${JSON.stringify(moduleUrl)};
      await withBlob(${JSON.stringify(app)}, async blob => {
        await blob.writeJson("data/state.json", { ok: true });
        if (!(await blob.readJson("data/state.json")).ok) throw new Error("Readback mismatch");
      });
    `], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: {
        WM_JOB_ID: jobId, WM_TOKEN: "synthetic-token", WM_WORKSPACE: "test",
        BASE_INTERNAL_URL: server.url.origin, BLOB_LOCAL_ROOT: join(root, "blobs"),
        // Legacy config and CLI auth must not override automatic job detection.
        BLOB_BACKEND: jobId ? "local" : "b2",
        AWS_ACCESS_KEY_ID: "synthetic-key", AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      },
    });
    const [exitCode, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, error };
  }
  try {
    expect(await run("local-app", "")).toEqual({ exitCode: 0, error: "" });
    expect(await Bun.file(join(root, "blobs/apps/local-app/data/state.json")).json()).toEqual({ ok: true });
    expect(resourceReads).toBe(0);
    expect(objects.size).toBe(0);
    expect(await run("remote-app", "test-job")).toEqual({ exitCode: 0, error: "" });
    expect(resourceReads).toBe(1);
    expect(objects.has("/test-bucket/apps/remote-app/data/state.json")).toBe(true);
    expect(await Bun.file(join(root, "blobs/apps/remote-app/data/state.json")).exists()).toBe(false);
    denyResource = true;
    expect((await run("failed-app", "test-job")).exitCode).not.toBe(0);
    expect(await Bun.file(join(root, "blobs/apps/failed-app/data/state.json")).exists()).toBe(false);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
