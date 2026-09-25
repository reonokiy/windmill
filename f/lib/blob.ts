// Bun handles file contents and deletion; fs supplies atomic rename and secure descriptors.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createB2, getB2, type B2Config } from "./b2.ts";

export interface WriteOptions { contentType?: string }

/** Minimal adapter contract; application code uses BlobStore below. */
export interface BlobBackend {
  write(key: string, body: string | Uint8Array, options?: WriteOptions): Promise<number>;
  readBytes(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export type BlobConfig =
  | { backend: "b2"; config: B2Config }
  | { backend: "b2"; resource?: string }
  | { backend: "local"; root: string }
  | { backend: "windmill"; storage?: string };

function appPrefix(app: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(app) || app === "lib") {
    throw new Error("App ID must be lowercase kebab-case; lib is reserved");
  }
  return `apps/${app}/`;
}

export function scopeBlob(app: string, backend: BlobBackend) {
  const prefix = appPrefix(app);
  function key(path: string): string {
    if (!path || /[\\\u0000-\u001f\u007f]/.test(path) ||
        path.split("/").some(part => part === "" || part === "." || part === "..")) {
      throw new Error("Storage path must be relative, without empty, dot or parent segments");
    }
    return prefix + path;
  }
  function write(path: string, body: string | Uint8Array, options?: WriteOptions) {
    return backend.write(key(path), body, { contentType: "application/octet-stream", ...options });
  }
  function readBytes(path: string) { return backend.readBytes(key(path)); }
  function readText(path: string) { return readBytes(path).then(bytes => new TextDecoder().decode(bytes)); }
  return {
    prefix, key, write, readBytes, readText,
    writeText: (path: string, text: string, options?: WriteOptions) =>
      write(path, text, { contentType: "text/plain; charset=utf-8", ...options }),
    writeJson(path: string, value: unknown, options?: WriteOptions) {
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError("Value cannot be serialized as JSON");
      return write(path, text, { contentType: "application/json; charset=utf-8", ...options });
    },
    async readJson<T = unknown>(path: string): Promise<T> { return JSON.parse(await readText(path)) as T; },
    delete: (path: string) => backend.delete(key(path)),
  };
}

export type BlobStore = ReturnType<typeof scopeBlob>;

/** Local debugging uses disk; Windmill jobs automatically use the existing B2 resource. */
export async function createBlob(app: string, config?: BlobConfig): Promise<BlobStore> {
  config ??= process.env.WM_JOB_ID?.trim()
    ? { backend: "b2" }
    : { backend: "local", root: process.env.BLOB_LOCAL_ROOT?.trim() || ".local/blobs" };
  appPrefix(app); // Validate before creating directories or accessing resources.
  switch (config.backend) {
    case "b2": return scopeBlob(app, "config" in config ? createB2(config.config) : await getB2(config.resource));
    case "local": return scopeBlob(app, await createLocalBackend(config.root));
    case "windmill": return scopeBlob(app, await createWindmillBackend(config.storage));
  }
}

/** Business functions use the same wrapper in local development and Windmill jobs. */
export async function withBlob<T>(app: string, run: (blob: BlobStore) => Promise<T>, config?: BlobConfig): Promise<T> {
  return run(await createBlob(app, config));
}

function code(error: unknown) { return error && typeof error === "object" && "code" in error ? error.code : undefined; }

/** Local development storage. The root must be owned by the caller, not other writers. */
async function createLocalBackend(root: string): Promise<BlobBackend> {
  if (!root.trim()) throw new Error("Local blob root is required");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  async function resolve(key: string, create: boolean) {
    const parts = key.split("/");
    if (!key || /[\\\u0000-\u001f\u007f]/.test(key) || parts.some(p => !p || p === "." || p === "..")) throw new Error("Invalid local blob key");
    let directory = base;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (code(error) !== "EEXIST") throw error; });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Local blob paths cannot contain symlinks or non-directories");
    }
    return join(directory, parts.at(-1)!);
  }
  return {
    async write(key, body) {
      const target = await resolve(key, true);
      const temporary = join(dirname(target), `.blob-${crypto.randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await Bun.write(Bun.file(file.fd), body); } finally { await file.close(); }
        await rename(temporary, target);
      } finally { await Bun.file(temporary).delete().catch(error => { if (code(error) !== "ENOENT") throw error; }); }
      return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    },
    async readBytes(key) {
      try {
        const file = await open(await resolve(key, false), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { return await Bun.file(file.fd).bytes(); } finally { await file.close(); }
      } catch (error) {
        if (code(error) === "ENOENT") throw Object.assign(new Error("Blob not found"), { code: "NoSuchKey" });
        throw error;
      }
    },
    async delete(key) {
      try { await Bun.file(await resolve(key, false)).delete(); }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
    },
  };
}

/** Uses the workspace default or a named secondary storage, consistently for all operations. */
export async function createWindmillBackend(storage?: string, client?: Pick<typeof import("windmill-client"), "writeS3File" | "loadS3File" | "deleteS3File">): Promise<BlobBackend> {
  const sdk = client ?? await import("windmill-client");
  const object = (key: string) => ({ s3: key, ...(storage ? { storage } : {}) });
  return {
    async write(key, body, options) {
      const payload = typeof body === "string" ? body : new Blob([new Uint8Array(body)]);
      const result = await sdk.writeS3File(object(key), payload, undefined, options?.contentType);
      if (typeof result === "string" || result.s3 !== key || result.storage !== (storage || undefined)) throw new Error("Windmill returned an unexpected blob location");
      return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    },
    async readBytes(key) {
      try {
        const bytes = await sdk.loadS3File(object(key));
        if (bytes === undefined) throw Object.assign(new Error("Blob not found"), { code: "NoSuchKey" });
        return bytes;
      } catch (error) {
        // The pinned SDK embeds storage errors in text. Do not hide arbitrary HTTP 404s,
        // which can also mean a missing workspace/route, or permission/configuration errors.
        if (error instanceof Error && /<Code>NoSuchKey<\/Code>/.test(error.message)) {
          throw Object.assign(new Error("Blob not found"), { code: "NoSuchKey" });
        }
        throw error;
      }
    },
    async delete(key) { await sdk.deleteS3File(object(key)); },
  };
}
