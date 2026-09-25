import { createBlob } from "../f/lib/blob.ts";

const [operation, key] = process.argv.slice(2);
if (operation !== "roundtrip" && !(operation === "read" && key)) {
  console.error("Usage: mise run blob:local -- read KEY | roundtrip");
  process.exit(1);
}

const blob = await createBlob(process.env.APP_ID ?? "local-debug");

if (operation === "read") {
  // Only print metadata, not potentially sensitive file contents.
  const bytes = await blob.readBytes(key!);
  console.log({ key: blob.key(key!), bytes: bytes.byteLength });
} else {
  const testKey = `tmp/debug/${crypto.randomUUID()}.json`;
  try {
    const value = { message: "Blob local roundtrip", id: crypto.randomUUID() };
    await blob.writeJson(testKey, value);
    const readback = await blob.readJson<typeof value>(testKey);
    if (readback.id !== value.id || readback.message !== value.message) {
      throw new Error("Blob roundtrip returned unexpected content");
    }
    console.log({ key: blob.key(testKey), roundtrip: "passed" });
  } finally {
    await blob.delete(testKey);
  }
}
