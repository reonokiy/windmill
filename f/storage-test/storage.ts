import { withAppStorage, type AppStorage } from "../lib/app_storage.ts";

export function withStorage<T>(run: (storage: AppStorage) => Promise<T>) {
  return withAppStorage("storage-test", run);
}
