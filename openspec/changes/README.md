# OpenSpec Changes

This directory tracks OctoClaw change packages. Each subdirectory has at minimum
`proposal.md`, `design.md`, and `tasks.md`.

## Layout

```
openspec/changes/
  <change-id>/         active work (in flight or queued for the current release)
  archive/             completed and shipped, retained as historical record
  parking/             deferred or out-of-scope for the current release
```

A change in `archive/` ships in a release. A change in `parking/` does not — it
is parked until a future release scope picks it up.

## Active changes

These are the focus right now (v0.5.x → v0.6.0 stabilization). Each must drive
toward "merged + tasks fully checked + archive" or be moved to `parking/`.

| Change | Intent |
|--------|--------|
| `runtime-extension-entry-slim-0.5.x` | Slice `extension-entry.ts` (3,981 lines) into focused modules so future edits stop being scary |
| `runtime-dead-placeholder-removal-0.5.x` | Remove no-op stubs (`compound`, no-op aggregators) left from the TS rebuild |
| `runtime-gate-convergence-0.5.x` | Finish footer/started-wording/main-fallback evidence loop (WP-E + smoke) |
| `runtime-timeout-watchdog-evidence-0.5.x` | Persist transition events + startup reconcile (Phase 2) |
| `v0.6-stability-hardening` | Slack smoke 5 cases + `degraded`/`delivered` operator surface + judge cooldown + shadow-lane invariants |
| `v0.6-im-feishu-deepen` | Feishu `splitMessage` + multi-part send |
| `planner-confirm-0.5.0-refactor` | Remaining planner/confirm cleanups |
| `planner-preload-0.5.1` | Remaining preload cleanups |

## Archived (shipped)

See `archive/README.md` for the full table. Highlights:

- Auto Router V3 Phase A + B + the bulk of Phase C (`@octoclaw/router` package,
  judge 3-field schema, capability snapshot, scoring engine, shadow selector,
  promotion review, decisions log, cost report, override CLI). Anything still
  open from V3 — full 7-step interactive wizard, plan quota auto-poll, end-to-end
  release smoke — moved to `parking/router-v3-wizard-and-release/`.
- Auto Router Lite shadow wiring (`extensions/octoclaw-runtime/src/router-lite/`).
- Streaming-channel ACK tier skip (Slack native streaming bypasses tier 1/2/3).
- Runtime convergence cleanup, lifecycle reducer Phase 1, dispatch admission.
- Friendly errors + `octoclawctl doctor` + npm `@octoclaw/cli` packaging.
- IM Discord and Telegram adapters.
- GitHub community files (issue templates, PR template, code of conduct, security).

## Parking (deferred)

See `parking/README.md`. These are designs we still want, but not in the v0.6.0
release window. Code may already exist; spec parking just means "do not block
v0.6.0 acceptance on this".

## Promotion rules

- A change moves from active → `archive/` when:
  - all `tasks.md` checkboxes are either ticked or annotated with a "skipped:
    no environment" note (e.g. live Slack smoke);
  - a short "what shipped vs what didn't" preamble is added to its `tasks.md`;
  - all of its production code is on `main`.
- A change moves from active → `parking/` when:
  - the design is still wanted but the work is descoped from the current
    release;
  - the parking note records the trigger to revisit ("after 100 active users",
    "after 30+ shadow samples", etc.).
- A change is created (not parked) when scope and acceptance criteria can be
  written today.
