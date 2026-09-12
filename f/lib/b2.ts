import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

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
  metadata?: Record<string, string>;
}

export const DEFAULT_B2_RESOURCE = "u/reonokiy/b2";

/** Creates an independent client. Call destroy() when finished. */
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

  const client = new S3Client({
    endpoint: endpoint.toString(),
    region: config.region,
    forcePathStyle: config.pathStyle ?? true,
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are passed through by the worker.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  function object(key: string) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("B2 object key must not be empty");
    }
    // Preserve keys exactly: leading slashes, spaces and Unicode are valid in S3.
    return { Bucket: config.bucket, Key: key };
  }

  async function read(key: string) {
    const result = await client.send(new GetObjectCommand(object(key)));
    if (!result.Body) throw new Error("B2 returned no response body");
    return result.Body;
  }

  async function write(key: string, body: string | Uint8Array, options: WriteOptions = {}) {
    const result = await client.send(new PutObjectCommand({
      ...object(key),
      Body: body,
      ContentLength: typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength,
      ContentType: options.contentType ?? "application/octet-stream",
      Metadata: options.metadata,
    }));
    return { key, bucket: config.bucket, etag: result.ETag, versionId: result.VersionId };
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
      return (await read(key)).transformToByteArray();
    },
    async readText(key: string): Promise<string> {
      return (await read(key)).transformToString("utf-8");
    },
    async readJson<T = unknown>(key: string): Promise<T> {
      return JSON.parse(await (await read(key)).transformToString("utf-8")) as T;
    },
    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand(object(key)));
    },
    destroy() {
      client.destroy();
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

/** Recommended for jobs: always closes the client, including when the callback fails. */
export async function withB2<T>(run: (b2: B2) => Promise<T>, resourcePath = DEFAULT_B2_RESOURCE): Promise<T> {
  const b2 = await getB2(resourcePath);
  try {
    return await run(b2);
  } finally {
    b2.destroy();
  }
}
