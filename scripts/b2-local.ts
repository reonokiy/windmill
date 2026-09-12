import { createAppStorage } from "../f/lib/app_storage.ts";

const [operation, key] = process.argv.slice(2);
if (operation !== "roundtrip" && !(operation === "read" && key)) {
  console.error("Usage: mise run b2:local -- read KEY | roundtrip");
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in your local .env before running`);
  return value;
}

const b2 = createAppStorage(required("APP_ID"), {
  bucket: required("B2_BUCKET"),
  endPoint: required("B2_ENDPOINT"),
  region: required("B2_REGION"),
  pathStyle: process.env.B2_PATH_STYLE !== "false",
});

try {
  if (operation === "read") {
    // Only print metadata, not potentially sensitive file contents.
    const bytes = await b2.readBytes(key!);
    console.log({ key: b2.key(key!), bytes: bytes.byteLength });
  } else {
    const testKey = `tmp/debug/${crypto.randomUUID()}.json`;
    try {
      const value = { message: "Windmill B2 local roundtrip", id: crypto.randomUUID() };
      await b2.writeJson(testKey, value);
      const readback = await b2.readJson<typeof value>(testKey);
      if (readback.id !== value.id || readback.message !== value.message) {
        throw new Error("B2 roundtrip returned unexpected content");
      }
      console.log({ key: b2.key(testKey), roundtrip: "passed" });
    } finally {
      await b2.delete(testKey);
    }
  }
} finally {
  b2.destroy();
}
