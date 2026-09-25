# Repository conventions

- Each application has a stable lowercase kebab-case ID, such as `daily-report`.
- Application code lives in `f/<app-id>/`. Reserve `f/lib/` for shared modules.
- Keep an application's Windmill scripts, flows, apps, metadata, and lockfiles together.
- Business scripts use `withBlob(appId, callback)` from `f/lib/blob.ts`.
  The wrapper automatically uses local disk outside Windmill and the existing B2
  resource inside Windmill jobs; business code does not select a backend.
  All blob backends use the logical prefix `apps/<app-id>/`; callers pass relative paths only.
- Use `data/` for persisted application data, `input/` for incoming files, `output/`
  for produced artifacts, and `tmp/` for temporary files (no automatic expiration).
- Define the app ID once in `f/<app-id>/storage.ts` and export an app-bound wrapper.
  Other scripts in that application import the wrapper instead of repeating the ID.
- Keep storage backend, endpoint and authentication details out of business code. Use the existing
  Windmill resource in jobs and `.env` for local development. Never commit credentials.
- Use mise for runtimes and CLIs; run `mise run verify` after logic changes.

- Business functions use `SecretStore` from `f/lib/secrets.ts`; define local/Windmill
  bindings in the application's `secrets.ts`. Select local env vs Windmill automatically
  using `WM_JOB_ID`. Local environment variables are read-only; only remote Windmill
  secrets support updates. Never persist secrets in blob storage.
