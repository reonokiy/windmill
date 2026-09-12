import { createB2, withB2, type B2, type B2Config, type WriteOptions } from "./b2.ts";

function appPrefix(app: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(app) || app === "lib") {
    throw new Error("App ID must be lowercase kebab-case; lib is reserved");
  }
  return `apps/${app}/`;
}

function scopedStorage(b2: B2, prefix: string) {
  function key(path: string): string {
    if (
      !path || /[\\\u0000-\u001f\u007f]/.test(path) ||
      path.split("/").some(part => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Storage path must be relative, without empty, dot or parent segments");
    }
    return prefix + path;
  }

  return {
    prefix,
    key,
    write: (path: string, body: string | Uint8Array, options?: WriteOptions) => b2.write(key(path), body, options),
    writeText: (path: string, text: string, options?: WriteOptions) => b2.writeText(key(path), text, options),
    writeJson: (path: string, value: unknown, options?: WriteOptions) => b2.writeJson(key(path), value, options),
    readBytes: (path: string) => b2.readBytes(key(path)),
    readText: (path: string) => b2.readText(key(path)),
    readJson: <T = unknown>(path: string) => b2.readJson<T>(key(path)),
    delete: (path: string) => b2.delete(key(path)),
  };
}

export type AppStorage = ReturnType<typeof scopedStorage>;

/** Local/server use. Caller owns this client and must destroy it when finished. */
export function createAppStorage(app: string, config: B2Config) {
  const prefix = appPrefix(app);
  const b2 = createB2(config);
  return { ...scopedStorage(b2, prefix), destroy: () => b2.destroy() };
}

/** Windmill jobs use the fixed apps/<app>/ prefix and close connections automatically. */
export async function withAppStorage<T>(
  app: string,
  run: (storage: AppStorage) => Promise<T>,
): Promise<T> {
  const prefix = appPrefix(app);
  return withB2(b2 => run(scopedStorage(b2, prefix)));
}
