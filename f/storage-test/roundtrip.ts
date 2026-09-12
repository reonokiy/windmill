import type { AppStorage } from "../lib/app_storage.ts";
import { withStorage } from "./storage.ts";

/** Also exercised against the local S3 mock by the test suite. */
export async function testStorage(storage: AppStorage) {
  const run = `tmp/${crypto.randomUUID()}`;
  const paths = [`${run}/text.txt`, `${run}/data.json`, `${run}/binary.bin`];
  const bytes = new Uint8Array([0, 127, 128, 255]);
  const failures: unknown[] = [];
  try {
    await storage.writeText(paths[0], "Windmill B2 测试 🌍");
    if (await storage.readText(paths[0]) !== "Windmill B2 测试 🌍") throw new Error("Text mismatch");
    await storage.writeJson(paths[1], { run, ok: true });
    const json = await storage.readJson<{ run: string; ok: boolean }>(paths[1]);
    if (json.run !== run || json.ok !== true) throw new Error("JSON mismatch");
    await storage.write(paths[2], bytes);
    const actual = await storage.readBytes(paths[2]);
    if (actual.length !== bytes.length || actual.some((value, i) => value !== bytes[i])) {
      throw new Error("Binary mismatch");
    }
  } catch (error) {
    failures.push(error);
  } finally {
    // Attempt every cleanup even when one delete fails. Preserve the original error.
    const cleanup = await Promise.allSettled(paths.map(path => storage.delete(path)));
    failures.push(...cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []));
  }
  if (failures.length) throw new AggregateError(failures, "B2 test or cleanup failed");
  for (const path of paths) {
    try {
      await storage.readBytes(path);
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") continue;
      throw error;
    }
    throw new Error("Deleted test object is still readable");
  }
  return { ok: true, prefix: storage.key(`${run}/result`).replace(/result$/, ""), checks: ["text", "json", "binary", "delete"], cleanedUp: true };
}

export async function main() {
  return withStorage(testStorage);
}
