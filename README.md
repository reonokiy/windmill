# Windmill

Scripts, flows, and apps for [Windmill on Talos](https://windmill.nokiy.net).

## Conventions

| Location | Purpose |
| --- | --- |
| `f/<app-id>/` | Application scripts, flows, apps, and metadata |
| `f/<app-id>/storage.ts` | Application storage wrapper |
| `f/lib/` | Shared TypeScript modules |
| `apps/<app-id>/` | Logical blob prefix for every backend |

Use a stable lowercase kebab-case app ID. Store files under `data/`, `input/`,
`output/`, or `tmp/`; applications are responsible for temporary-file cleanup.

## Storage

Bind the app ID once in `f/<app-id>/storage.ts`:

```ts
import { withBlob, type BlobStore } from "../lib/blob.ts";

export function withStorage<T>(run: (storage: BlobStore) => Promise<T>) {
  return withBlob("daily-report", run);
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

Business functions depend only on `BlobStore` from `f/lib/blob.ts`. No backend configuration
is needed for normal use:

```ts
const blob = await createBlob("daily-report");
await blob.writeJson("data/state.json", { cursor: 42 });
```

`createBlob(appId)` and `withBlob(appId, callback)` automatically select:

- Local execution: `.local/blobs/apps/<app-id>/...`; no credentials are needed.
  Set `BLOB_LOCAL_ROOT` only to override the local directory.
- Windmill job (`WM_JOB_ID` is set): existing resource `u/reonokiy/b2`, with credentials
  from the worker. Storage errors fail the job; they never fall back to local disk.

Having `WM_TOKEN` or `WM_WORKSPACE` locally for CLI access does not select remote storage.
The old `BLOB_BACKEND` setting is no longer used. Explicit `BlobConfig` is still accepted
for tests and specialized access, including `{ backend: "windmill", storage: "archive" }`.

| Backend | Implementation | Location |
| --- | --- | --- |
| `b2` | Bun S3Client, worker/environment credentials | Configured bucket |
| `local` | Filesystem, atomic file replacement | `<root>/apps/<app-id>/...` |
| `windmill` | Windmill SDK, workspace authentication | Default or named secondary workspace storage |

Local file contents use `Bun.file()` / `Bun.write()` and deletion uses `BunFile.delete()`.
The remaining `node:fs` calls provide secure file descriptors, directory checks, permissions
and atomic rename, which Bun's file API does not expose.

Write methods return UTF-8/binary byte counts. Missing objects expose `code: "NoSuchKey"`
when the backend identifies them as such; permission and configuration failures propagate.
Windmill errors that do not identify a missing object retain their original SDK error.
The local backend rejects traversal and symlink reads; its root must be owned by the
caller and not concurrently modified by untrusted processes. `contentType` is sent to
object storage; local files retain bytes only. Objects/files are buffered in memory.
Deletes remove the current object/file, not historical object-storage versions.
Offline backend contract checks live in `tests/helpers/blob.ts`.
Windmill storage uses the official [workspace object storage API](https://www.windmill.dev/docs/core_concepts/object_storage_in_windmill).

## Secrets

Use `SecretStore` from `f/lib/secrets.ts` in business functions. Declare the names once
in `f/<app-id>/secrets.ts`; backend selection is automatic, just like blob storage:

```ts
import { createSecrets } from "../lib/secrets.ts";

const secrets = createSecrets({
  apiKey: { windmill: "u/reonokiy/example_api_key", env: "EXAMPLE_API_KEY" },
  auth: { windmill: "u/reonokiy/example_auth", env: "PI_AUTH_JSON" },
});

const apiKey = await secrets.get("apiKey");
const auth = await secrets.getJson("auth");
```

Without `WM_JOB_ID`, secrets read environment variables (Bun loads `.env` locally).
The local backend is read-only: `set` / `setJson` throw without changing the process
environment or any file. Setting local CLI credentials such as `WM_TOKEN` does not
select the Windmill backend.

Inside Windmill jobs, secrets read and update the mapped secret variables; writes always
set `isSecret: true`. `secrets.writable` indicates whether updates are supported.
OAuth can refresh and persist credentials remotely. Local debugging uses a valid access
token from `PI_AUTH_JSON`; expired credentials require a new login and environment update,
without attempting token rotation. Local API-key credentials also use `PI_AUTH_JSON`.

Missing or malformed secrets fail explicitly, without printing secret values or raw
provider error bodies. Windmill access failures never fall back to local values.
Secrets never use blob storage. See `f/us-equity-monitor/secrets.ts` for the real mapping.

## Applications

- [US equity monitor](f/us-equity-monitor/README.md): five-minute equity research
  using a custom pi loop, Codex OAuth, and market-data tools; sends quotes and a short opinion to Telegram.

## Local development

[mise](https://mise.jdx.dev/) pins runtimes and CLIs; Bun dependencies use `bun.lock`.

```sh
mise trust
mise install
mise run install
mise run verify
```

Verification runs type checks, offline backend tests in Bun, and workflow linting.
The default local backend needs no credentials:

```sh
mise run blob:local -- roundtrip
mise run blob:local -- read data/state.json
mise run blob:debug -- read data/state.json
```

The CLI reads `APP_ID` (default `local-debug`) and optional `BLOB_LOCAL_ROOT`.
It uses the same automatic configuration as business functions. Local debugging needs
no B2 endpoint, bucket, region, or AWS credentials. Use `blob:local` / `blob:debug`;
the old `b2:local` / `b2:debug` tasks have been removed.

## Deployment

Push to `main` to run checks and sync to the `windmill` workspace. Pull requests run checks only. Authentication uses the GitHub Actions
secret `WMILL_TOKEN`, generated in Windmill **Account settings → Tokens**.

CI generates script metadata and dependency locks before deployment. Sync preserves
remote-only items and skips resources, variables, and secrets.

For manual sync, configure a local profile with `mise exec -- bun run --bun wmill workspace add`,
then use `mise run wmill:pull` or `mise run wmill:push`.

### OpenBao credentials through fnox

The Talos instance uses `https://bao.nokiy.net`, KV v2 at `kv/`, and personal
paths `kv/users/<entity-id>/` protected by the `openbao-user` policy.
Membership in Pocket ID's `openbao-users` group is required for these paths;
the `openbao-operator` policy alone cannot read their values.

1. Run `mise run bao:login` and complete Pocket ID device login in your terminal.
   The role is named `openbao-operator`, but its policies come from Pocket ID
   group membership, including `openbao-users`.
2. If not already stored, store your Windmill API token in the OpenBao UI at
   `kv/users/<entity-id>/windmill`, field `token` (or use its existing path).
3. Run `mise run wmill:bao -- script list` to verify authenticated access.
   To deploy, run `mise run wmill:bao -- sync push --auto-metadata --keep-deleted`.

`fnox.toml` is ready to use and contains references only. No local config copy
is needed. The adapter resolves `kv/users/@self` to the authenticated user's
entity ID, so no personal ID is hardcoded. `@self` is this repository's adapter
convention, not a native fnox/OpenBao path. If your existing token is stored
elsewhere, change the provider path and secret reference in `fnox.toml`.

fnox captures the OpenBao session token from the CLI token helper and injects
`WM_TOKEN`, `WM_WORKSPACE`, and `BASE_INTERNAL_URL` directly into the Windmill CLI.
No Windmill workspace profile or plaintext Windmill token file is needed.
OpenBao login uses its normal local token helper; log in again when it expires.
The process-scoped `vault` adapter translates fnox's Vault CLI calls to `bao`.
The task command is defined directly in `mise.toml`; no launcher script is used.
The adapter is needed because fnox 1.30 invokes an executable named `vault`
and supplies `VAULT_*`, whereas OpenBao uses `bao` and `BAO_*`.
Existing CI tasks still use the GitHub Actions secret; this is a local opt-in path.

### VS Code type hints

Run `mise run install` to install TypeScript and Bun types. Install the recommended
Microsoft TypeScript 7 extension (`TypeScriptTeam.native-preview`). Workspace settings
select the native language server from `node_modules/typescript`, matching CLI checks.
Bun's extension provides runtime/debugger integration; TypeScript supplies completion
and hover types. Reload the VS Code window after installing the extension if needed.
