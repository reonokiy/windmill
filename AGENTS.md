# Repository conventions

- Each application has a stable lowercase kebab-case ID, such as `daily-report`.
- Application code lives in `f/<app-id>/`. Reserve `f/lib/` for shared modules.
- Keep an application's Windmill scripts, flows, apps, metadata, and lockfiles together.
- Business scripts use `withAppStorage(appId, callback)` from `f/lib/app_storage.ts`.
  B2 objects always live under `apps/<app-id>/`; callers pass relative paths only.
- Use `data/` for persisted application data, `input/` for incoming files, `output/`
  for produced artifacts, and `tmp/` for temporary files (no automatic expiration).
- Define the app ID once in `f/<app-id>/storage.ts` and export an app-bound wrapper.
  Other scripts in that application import the wrapper instead of repeating the ID.
- Keep B2 endpoint and authentication details out of business code. Use the existing
  Windmill resource in jobs and `.env` for local development. Never commit credentials.
- Use mise for runtimes and CLIs; run `mise run verify` after logic changes.
