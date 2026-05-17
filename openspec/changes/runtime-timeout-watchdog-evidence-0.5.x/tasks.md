# Tasks

## WP-A Spec And Design

Owner: Codex.

Write scope:

- `docs/octoclaw-timeout-watchdog-evidence-design-2026-05-12.md`
- `openspec/changes/runtime-timeout-watchdog-evidence-0.5.x/**`

Tasks:

- [x] Document timeout/stall/completed-without-result problem.
- [x] Document deterministic watchdog/reconciler architecture.
- [x] Document optional tmux evidence and main-agent compact-context limits.
- [x] Add OpenSpec proposal/design/spec/tasks.

Acceptance:

- [x] Design rejects completion-file/finalizer rollback.
- [x] Design keeps tmux optional and diagnostic-only.

## WP-B Lifecycle Reducer And Evidence Types

Owner: OpenCode/GLM-5.1 implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/runtime-ledger/lifecycle-reconciler.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/lifecycle-reconciler.test.ts`
- Small exports from adjacent runtime-ledger index files if needed.

Tasks:

- [x] Add evidence input types for native, receipt, artifact, deadlines, and optional tmux/process evidence.
- [x] Add pure reducer for `queued`, `running`, `running_slow`, `stalled`, `timed_out`, `failed`, `degraded`, and `completed`.
- [x] Ensure native completed without result evidence returns `degraded` with reason `completed_without_result`.
- [x] Ensure expected deadline with live active evidence returns `running_slow`.
- [x] Ensure expected deadline with alive-but-idle evidence returns `stalled`.
- [x] Ensure hard timeout with no live evidence returns `timed_out`.
- [x] Add compact parent packet builder with token/context hygiene fields only.

Acceptance:

- [x] Focused reducer tests cover all status transitions above.
- [x] Reducer is pure and does not read files, tmux, native registry, or sqlite directly.

## WP-C Status Projection Integration

Owner: OpenCode/GLM-5.1 implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts`
- Existing runtime-status tests or a new focused test if none exists.

Tasks:

- [x] Use reducer semantics when rendering ledger-backed task-state records.
- [x] Stop projecting native/contract completed without result evidence as normal `completed` or `deliverable_ready`.
- [x] Surface `completed_without_result` in status reason/result location.
- [x] Keep existing completed-with-result behavior intact.

Acceptance:

- [x] Native/contract completed + no result evidence displays degraded/completed_without_result.
- [x] Completed + receipt/artifact/report displays completed.

## WP-D Watchdog Reconcile And Tmux Evidence Provider

Owner: OpenCode/GLM-5.1 implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/ack/ack-watchdog.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/lifecycle-reconciler.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/tmux-evidence.ts`
- `extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-integration.test.ts`
- New focused tests for tmux evidence if practical.

Tasks:

- [x] Shift watchdog stale-running decisions through native read + reducer evidence; do not assume task-state cache alone is lifecycle truth.
- [x] Add optional tmux evidence provider behind `OCTOCLAW_TMUX_EVIDENCE=1`.
- [x] Capture bounded tmux data only: alive, command/cwd if available, output hash/change, short redacted excerpt.
- [x] Do not let tmux evidence prove success.
- [ ] Persist reducer transition events for running_slow/stalled/timed_out/completed_without_result in the ledger. — NOT YET IMPLEMENTED: reducer computes status but does not write transition events to runtime_events table.
- [x] Keep notification best-effort and deduped through the existing transition notifier path.

Acceptance:

- [x] Watchdog surfaces slow active tasks as reducer-derived non-success states instead of direct failure.
- [x] Watchdog can mark hard timeout with no live evidence as timed_out.
- [x] Tmux disabled path behaves as before except reducer status semantics.

## WP-E Status Query And Startup Reconcile Hooks

Owner: OpenCode/GLM-5.1 implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- Reconciler helper files/tests as needed.

Tasks:

- [x] Run lightweight reducer projection before `octoclaw_status`/task detail renders active or recent tasks.
- [x] Add startup reconcile for unfinished attempts. — Implemented: `watchdogStartupReconcile()` in `ack-watchdog.ts:321`, hooked in `ack-guard.ts:64`, tests in `watchdog-startup-reconcile.test.ts`.
- [x] Do not retry or restart tasks during startup reconcile. — Implemented: startup reconcile only updates projection, never triggers spawn/retry.
- [x] Deduplicate startup notifications. — Implemented: dedupe in watchdogStartupReconcile path.

Acceptance:

- [x] Status query discovers stale/timed-out/degraded tasks even if prior notification was missed.
- [x] Runtime startup repairs unfinished task projection without auto-retry. — Implemented: watchdogStartupReconcile repairs projection without spawn.

## WP-F Context Hygiene And Verification

Owner: OpenCode implementation, Codex review and final verification.

Write scope:

- `extensions/octoclaw-runtime/src/conversation-grounding.ts`
- `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- Focused tests around compact packet/context rendering.

Tasks:

- [x] Ensure reducer compact parent packet excludes raw child transcript/raw tmux logs.
- [x] Include enough receipt summary/artifact/result location for main agent to judge obvious success/failure.
- [x] Add redaction/length caps for abnormal-state tmux excerpts.

Acceptance:

- [x] Compact packet does not contain transcript or full tmux output.
- [x] Abnormal states include a bounded reason/evidence summary.
- [x] Focused tests pass.

## WP-G Codex Review, Commit, Deploy

Owner: Codex.

Tasks:

- [x] Inspect OpenCode diff for scope and architecture drift.
- [x] Run focused tests selected by changed files.
- [x] Run package check/build as practical.
- [ ] Run `npx gitnexus detect-changes --scope staged` before commit.
- [ ] Commit and push.
- [ ] Deploy local runtime.
- [ ] Run post-deploy status check.
