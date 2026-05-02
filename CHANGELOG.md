# Changelog

## 0.5.0 (Unreleased)

### Added

- Planner/native `sessions_spawn` delegation path: `octoclaw_dispatch` now creates a `NativeSpawnIntent` and returns compact `sessionsSpawnArgs` for the main agent to pass to OpenClaw native `sessions_spawn`.
- `octoclaw_dispatch_confirm` records accepted native run evidence, writes WorkContract native refs, and sends the delegate ACK only after accepted confirm.
- SQLite-backed native spawn intent ledger, WorkContract native refs, and native status projection support for `sessions_spawn_planner`.

### Changed

- Planner path avoids the legacy scheduler queue, completion binding, child finalizer, and delivery outbox as the primary execution path.
- Confirm is hard-gated: accepted confirm requires `spawn_call_started` intent state and a non-empty top-level `runId`; `planned -> accepted` is rejected.

### Fixed

- Provider-safe confirm tool schema no longer uses top-level conditional JSON Schema keywords rejected by OpenClaw providers.
- Native spawn gate checks every candidate session alias before blocking on stale hash mismatch, including Slack channel/thread session aliases.

## 0.1.0

Public release based on internal milestone `v1.5.0`.

### Added

- Cost-sensitive role-aware model policy generation
- Session-aware patrol with steer-before-redispatch
- Persistent runner queue, dispatch entry, daemon, and health checks
- Generic text status rendering (`compact`, `table`, `lanes`)
- Configurable notification backend (`feishu`, `auto`, `none`)

### Notes

- This draft is optimized for a minimal usable OpenClaw workflow first
- Feishu support remains optional; text-mode status and runner flow are the recommended default open-source path
