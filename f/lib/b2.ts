import { S3Client } from "bun";

/** Connection fields from the Windmill S3 resource; credentials stay in the worker. */
export interface B2Config {
  bucket: string;
  endPoint: string;
  region: string;
  pathStyle?: boolean;
  useSSL?: boolean;
  port?: number;
}

export interface WriteOptions {
  contentType?: string;
}

export const DEFAULT_B2_RESOURCE = "u/reonokiy/b2";

/** Creates a Bun-native S3 client for the configured B2 bucket. */
export function createB2(config: B2Config) {
  for (const field of ["bucket", "endPoint", "region"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) {
      throw new Error(`B2 resource requires ${field}`);
    }
  }
  const endpoint = new URL(
    config.endPoint.includes("://")
      ? config.endPoint
      : `${config.useSSL === false ? "http" : "https"}://${config.endPoint}`,
  );
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("B2 endpoint must be an HTTP(S) URL without credentials");
  }
  if (config.port !== undefined) endpoint.port = String(config.port);

  const virtualHostedStyle = config.pathStyle === false;
  if (virtualHostedStyle) endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
  const client = new S3Client({
    endpoint: endpoint.toString(),
    bucket: config.bucket,
    region: config.region,
    virtualHostedStyle,
    // Read the worker's credentials explicitly, also supporting local .env.
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  });

  function file(key: string) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("B2 object key must not be empty");
    }
    return client.file(key);
  }

  function write(key: string, body: string | Uint8Array, options: WriteOptions = {}) {
    return file(key).write(body, {
      type: options.contentType ?? "application/octet-stream",
    });
  }

  return {
    write,
    writeText(key: string, text: string, options: WriteOptions = {}) {
      return write(key, text, { contentType: "text/plain; charset=utf-8", ...options });
    },
    writeJson(key: string, value: unknown, options: WriteOptions = {}) {
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError("Value cannot be serialized as JSON");
      return write(key, text, { contentType: "application/json; charset=utf-8", ...options });
    },
    async readBytes(key: string): Promise<Uint8Array> {
      return file(key).bytes();
    },
    async readText(key: string): Promise<string> {
      return file(key).text();
    },
    async readJson<T = unknown>(key: string): Promise<T> {
      return file(key).json() as Promise<T>;
    },
    async delete(key: string): Promise<void> {
      await file(key).delete();
    },
  };
}

export type B2 = ReturnType<typeof createB2>;

/** Uses the existing Windmill resource; no credential copying or hardcoding. */
export async function getB2(resourcePath = DEFAULT_B2_RESOURCE): Promise<B2> {
  const { getResource } = await import("windmill-client");
  const config = await getResource(resourcePath) as B2Config | undefined;
  if (!config) throw new Error(`B2 resource not found: ${resourcePath}`);
  return createB2(config);
}

/** Uses the configured bucket for a job callback. */
export async function withB2<T>(run: (b2: B2) => Promise<T>, resourcePath = DEFAULT_B2_RESOURCE): Promise<T> {
  return run(await getB2(resourcePath));
}
