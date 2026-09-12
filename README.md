# Windmill

Scripts, flows, and apps for [Windmill on Talos](https://windmill.nokiy.net).

## Conventions

| Location | Purpose |
| --- | --- |
| `f/<app-id>/` | Application scripts, flows, apps, and metadata |
| `f/<app-id>/storage.ts` | Application storage wrapper |
| `f/lib/` | Shared TypeScript modules |
| `apps/<app-id>/` | B2 object prefix |

Use a stable lowercase kebab-case app ID. Store files under `data/`, `input/`,
`output/`, or `tmp/`; applications are responsible for temporary-file cleanup.

## Storage

Bind the app ID once in `f/<app-id>/storage.ts`:

```ts
import { withAppStorage, type AppStorage } from "../lib/app_storage.ts";

export function withStorage<T>(run: (storage: AppStorage) => Promise<T>) {
  return withAppStorage("daily-report", run);
}
```

Other scripts in that app import the wrapper:

```ts
import { withStorage } from "./storage.ts";

export async function main() {
  return withStorage(async (storage) => {
    await storage.writeJson("data/state.json", { cursor: 42 });
    return storage.readJson("data/state.json");
  });
}
```

This writes to `apps/daily-report/data/state.json`. All methods take relative paths.
Available methods: `writeText` / `readText`, `writeJson` / `readJson`,
`write` / `readBytes`, and `delete`.

Storage uses Bun’s built-in `S3Client` (no AWS SDK). Write methods return the number
of bytes written; S3 errors expose a `code` such as `NoSuchKey`.
The Windmill worker must use a Bun runtime supporting these APIs, not `//native`.

Connection settings come from `u/reonokiy/b2`; credentials come from the worker.
Files are buffered in memory. Deletes remove the current object, not historical versions.
See [storage-test](f/storage-test/) for a complete working example.

## Local development

[mise](https://mise.jdx.dev/) pins runtimes and CLIs; Bun dependencies use `bun.lock`.

```sh
mise trust
mise install
mise run install
mise run verify
```

Verification runs type checks, offline S3 tests in Bun, and workflow linting.
For live B2 debugging, copy `.env.example` to `.env` and fill in the connection settings
and credentials. The default `APP_ID=local-debug` uses `apps/local-debug/`.

```sh
mise run b2:local -- read data/state.json
mise run b2:debug -- read data/state.json
mise run b2:local -- roundtrip  # Writes, reads, and cleans up temporary objects
```

## Deployment

Push to `main` to run checks, sync to the `windmill` workspace, and execute the B2
roundtrip test. Pull requests run checks only. Authentication uses the GitHub Actions
secret `WMILL_TOKEN`, generated in Windmill **Account settings → Tokens**.

CI generates script metadata and dependency locks before deployment. Sync preserves
remote-only items and skips resources, variables, and secrets. The online test uses
`apps/storage-test/tmp/<uuid>/` and cleans up its objects.

For manual sync, configure a local profile with `mise exec -- bun run --bun wmill workspace add`,
then use `mise run wmill:pull`, `mise run wmill:push`, or `mise run wmill:test`.
