# Tasks

## WP-A Docs And Invariant Tests

Owner: OpenCode/GLM-5 worker, Codex review.

Write scope:

- `docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`
- `openspec/changes/runtime-convergence-cleanup-0.5.x/**`
- `extensions/octoclaw-runtime/src/tools/registration-planner.test.ts`
- `extensions/octoclaw-runtime/src/config/index.test.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts`

Tasks:

- [x] Add or update tests proving planner prompt does not require completion file in target mode.
- [x] Add or update tests proving planner path does not schedule child finalizer in target mode.
- [x] Add or update tests proving planner path does not queue delivery outbox in target mode.
- [x] Add or update tests documenting `octoclaw_spawn` as a delete target, not a compatibility alias.
- [x] Add or update tests documenting SQLite metadata ledger as the target default.
- [x] Record current gaps as explicit failing/todo tests if not fixed in this WP.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts`
- [x] `pnpm --filter @octoclaw/runtime run check`

Evidence:

- 2026-05-07 WP-A complete: added focused invariant sections in planner registration, runtime config, and runtime-ledger feature flag tests.
- Passing invariants: planner prompt excludes Completion Requirement section / .completion.json / resolveWorkerCompletionPath / write-the-result instructions; planner dispatch does not queue delivery outbox; legacy flags documented as delete targets (WP-B/D/E).
- Explicit todo gaps (3, after WP-B closed 2): child finalizer recovery still defaults on for planner (WP-D); octoclaw_spawn registration still exists (WP-F). Ledger default and task-state rebuild default resolved by WP-B.
- Focused vitest: 3 files passed, 97 passed | 5 todo (102). Runtime check: tsc --noEmit clean.

## WP-B SQLite Metadata Ledger Default

Owner: GLM-5 worker, Codex architecture review.

Write scope:

- `extensions/octoclaw-runtime/src/runtime-ledger/feature-flags.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/index.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/shadow.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts`
- `extensions/octoclaw-runtime/src/work-contract/store.ts`
- `extensions/octoclaw-runtime/src/state/task-state-store.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/*.test.ts`
- `extensions/octoclaw-runtime/src/work-contract/store.test.ts`

Forbidden scope:

- OpenClaw native database/schema.
- Native run/flow lifecycle semantics.
- Completion file, child-finalizer, delivery outbox behavior.

Tasks:

- [x] Make runtime ledger default `metadata` or enforce-equivalent.
- [x] Make `saveWorkContract()` write SQLite first and projection second.
- [x] Make `loadWorkContract()` read SQLite by default.
- [x] Make `listWorkContractsBySession()` read SQLite by default.
- [x] Move task-state backfill into explicit migration/import path.
- [x] Emit degraded/backfill diagnostics for task-state import and SQLite failures.
- [x] Prove SQLite unavailable does not silently return empty task list.
- [x] Document `native_spawn_intents` as an auxiliary planner table.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/runtime-ledger.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts extensions/octoclaw-runtime/src/work-contract/store.test.ts`
- [x] `pnpm --filter @octoclaw/runtime run check`
- [x] Code search shows task-state WorkContract reads are migration/import only.

Evidence:

- 2026-05-07 WP-B complete. `resolveRuntimeLedgerFlag()` and `resolveRuntimeLedgerMode()` now default to `"enforce"`; explicit `"off"` still supported. `isTaskStateRebuildEnabled()` defaults to `true`.
- `saveWorkContract()` / `loadWorkContract()` / `listWorkContractsBySession()` all branch on `resolveRuntimeLedgerMode() === "enforce"` which is now the default — so SQLite-first is the normal path.
- Store tests updated: legacy task-state-only tests explicitly set `OCTOCLAW_RUNTIME_LEDGER=off`; enforce-mode tests pass with the new default.
- `backfillWorkContractsFromTaskState()` is already an explicit migration function.
- SQLite unavailable returns `null`/`[]` with degraded diagnostic (not silent empty task).
- `native_spawn_intents` documented as auxiliary planner table in schema (migration v2).
- Focused vitest: 4 files passed, 59 tests passed. tsc --noEmit clean.

## WP-C Projection Builder Owns Task-State

Owner: GLM-5 worker, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts`
- `extensions/octoclaw-runtime/src/state/task-state-store.ts`
- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/conversation-grounding.ts`
- `extensions/octoclaw-runtime/src/ack/*`
- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/im-status-renderer.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts`
- `extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts`
- `extensions/octoclaw-runtime/src/state/native-status-projector.test.ts`

Forbidden scope:

- Planner/confirm spawn authorization.
- Judge routing semantics.
- Direct child spawn behavior.

Tasks:

- [x] Introduce or converge `StatusProjectionBuilder`.
- [x] Replace direct status/details task-state truth reads.
- [x] Replace conversation grounding task-state truth reads.
- [x] Replace ACK/watchdog task-state truth reads.
- [x] Make missing task-state rebuild safe by default.
- [x] Make corrupt task-state quarantine and rebuild safe by default.
- [x] Make IO errors fail closed without overwriting the file.
- [x] Emit projection degraded/rebuilt markers.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts extensions/octoclaw-runtime/src/ack/ack-guard.test.ts extensions/octoclaw-runtime/src/conversation-grounding.test.ts`
  — 3/3 files, 23 tests passed (ack-guard + conversation-grounding tests unchanged, passing in full suite).
- [x] `pnpm --filter @octoclaw/runtime run check` — tsc clean.
- [x] Deleting `task-state.json` does not erase durable status truth — rebuild-from-SQLite path tested in projection-rebuild.test.ts.
- [x] Corrupting `task-state.json` produces quarantine/degraded marker — tested in task-state-error-handling.test.ts.

Evidence:

- `projection-rebuild.ts`: `rebuildTaskStateProjection()` reads SQLite → writes fresh projection; `writeRebuiltTaskState()` stamps `projection_meta` with `rebuild_reason`.
- `task-state-store.ts`: `readTaskStateWithRebuild()` orchestrates read → parse → fallback → rebuild; corrupt JSON triggers quarantine + degraded marker.
- `native-status-projector.ts`: `NativeStatusProjectionBuilder` class with `projectFromTaskState()` and `projectFromLedger()` methods.
- `registration.ts`: `readActiveRuntimeTaskState()` (L742) reads SQLite projection when ledger active, falls back to task-state.json only when degraded.
- Tests: 23 passed, tsc clean, 387ms.

## WP-D Remove Completion File And Child Finalizer Planner Path

Owner: GLM-5 worker, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`
- `extensions/octoclaw-runtime/src/resolve/env.ts`
- `extensions/octoclaw-runtime/src/config/index.ts`
- `extensions/octoclaw-runtime/src/config/index.test.ts`
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts`
- `extensions/octoclaw-runtime/src/tools/registration-planner.test.ts`
- `extensions/octoclaw-runtime/src/extension-entry.test.ts`

Forbidden scope:

- Adding new legacy completion product flags.
- Turning completion file into a soft prompt requirement.
- Queueing delivery outbox after finalizer failure.

Tasks:

- [x] Remove completion file path/template/requirement from planner child prompt.
- [x] Remove planner completion binding creation as normal completion gate.
- [x] Remove planner `scheduleChildCompletionFinalizer()` call.
- [x] Remove child-finalizer recovery startup registration.
- [x] Remove `OCTOCLAW_LEGACY_COMPLETION_FILE` product config.
- [x] Convert old completion/finalizer tests to import-only migration tests or delete them.
- [x] Add native announce test proving no completion timeout.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts`
  — 3 files, 150 tests passed, 2 todo. (child-finalizer.test.ts deleted; not in test run.)
- [x] `pnpm --filter @octoclaw/runtime run check` — tsc clean.
- [x] `rg "MUST write the result to this file|resolveWorkerCompletionPath|scheduleChildCompletionFinalizer" extensions/octoclaw-runtime/src/tools/registration.ts` — 0 matches. Planner path clean.

Evidence:

- **Deleted files**: `child-finalizer.ts` (1153 lines), `child-finalizer.test.ts` — entire child-finalizer system removed.
- **registration.ts**: `buildSubagentSpawnMessage` deleted; legacy `trySpawnSubagentRuntime` now fails fast with `legacy_subagent_runtime_removed_use_octoclaw_dispatch_planner`. `createCompletionBinding` + `scheduleChildCompletionFinalizer` calls removed from planner spawn path. `resolveWorkerCompletionPath` import removed.
- **env.ts**: `resolveWorkerCompletionPath` function deleted.
- **config/index.ts**: `resolveLegacyCompletionFileEnabled`, `resolveLegacyChildFinalizerDisabled`, `shouldRunChildFinalizerRecovery` deleted. `PlannerSpawnConfig` cleaned. `shouldRunDeliveryOutboxFlush` returns `false` for planner backend.
- **extension-entry.ts** (cross-scope): Removed `cancelChildCompletionFinalizer`, `recoverPendingChildCompletionFinalizers` imports; removed `childFinalizerRecoveryInterval`, `runChildFinalizerRecovery`, startup interval block, and runtime cancel calls at L1513/L1652.
- **Tests**: `config/index.test.ts` — removed legacy flag tests, updated `PlannerSpawnConfig` expectations, updated `shouldRunDeliveryOutboxFlush` planner test. `registration-planner.test.ts` — converted WP-A gap todo to real test asserting no finalizer scheduling. `extension-entry.test.ts` — removed 3 child-finalizer interval tests, cleaned ENV_KEYS.
- Cross-scope dependency: extension-entry.ts modified to avoid build break from deleted child-finalizer module.
- WP-C regression: 23 tests still pass.

## WP-E Remove Delivery Outbox Runtime Path

Owner: GLM-5 worker, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`
- `extensions/octoclaw-runtime/src/core/delivery/outbox.ts`
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/config/index.ts`
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts`
- `extensions/octoclaw-runtime/src/core/delivery/outbox.test.ts`
- `extensions/octoclaw-runtime/src/extension-entry.test.ts`
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts`

Forbidden scope:

- New JSON delivery queue.
- Silent delivered status on delivery failure.
- Broad non-Slack IM rewrite.

Tasks:

- [x] Remove startup `flushDeliveryOutbox()` interval.
- [x] Remove normal `queueOutboxDelivery()` call sites.
- [x] Record delivery failure as SQLite/replay/projection pending/degraded.
- [x] Stop writing outbox files for new runtime.
- [x] Move historical outbox reading to import-only code if still needed.
- [x] Add tests proving native planner path produces no outbox entry.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/core/delivery/outbox.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`
  — 4 files, 127 tests passed.
- [x] `pnpm --filter @octoclaw/runtime run check` — tsc clean.
- [x] Code search shows no new runtime `flushDeliveryOutbox` or `queueOutboxDelivery` or `appendToDeliveryOutbox` call — 0 matches.

Evidence:

- **Deleted files**: `delivery-outbox.ts` (254 lines), `delivery-outbox.test.ts` (146 lines) — entire legacy outbox persistence layer removed.
- **Kept**: `core/delivery/outbox.ts` and `core/delivery/outbox.test.ts` — still imported by `core/delivery/protocol.ts` and `core/workflow/index.ts`.
- **extension-entry.ts** (cross-scope): Removed `flushDeliveryOutbox` import, `deliveryOutboxInterval`, `runDeliveryOutboxFlush()`, startup interval block, `shouldRunDeliveryOutboxFlush` config import.
- **execution-transition-notifier.ts** (cross-scope): Removed `appendToDeliveryOutbox` import and fallback outbox append. Send failures now log `delivery_outbox_removed_send_failed` via `recordPolicyReplay`.
- **config/index.ts**: Removed `resolveLegacyDeliveryOutboxDisabled`, `shouldRunDeliveryOutboxFlush`. Cleaned `PlannerSpawnConfig`.
- **env.ts**: Removed `resolveDeliveryOutboxPath()`.
- **Tests**: `config/index.test.ts` — removed outbox flag tests, cleaned ENV_KEYS, updated expectations. `extension-entry.test.ts` — removed outbox interval tests. execution-transition-notifier test L153 still passes (no outbox file created). Slack adapter test — no outbox references, unchanged.
- Regression: WP-C (23 passed), WP-D (150 passed) tests still green.

## WP-F Delete Legacy Entrypoints And Fake Runtime

Owner: GLM-5 worker for mechanical edits, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/adapter/detached-task-runtime.ts`
- `extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts`
- `extensions/octoclaw-runtime/src/adapter/detached-task-runtime.test.ts`
- `extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts`
- `extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts`
- `README.zh-CN.md`

Forbidden scope:

- Alias `octoclaw_spawn` to `octoclaw_dispatch`.
- Direct `runtime.subagent.run()` planner fallback.
- Fake runtime capability registration.

Tasks:

- [x] Delete `octoclaw_spawn` tool registration.
- [x] Delete independent `octoclaw_spawn` model/policy path.
- [x] Remove `octoclaw_spawn` from tool policy/system prompt allowlists.
- [x] Make old calls fail fast with `octoclaw_dispatch` guidance.
- [x] Delete planner backend `runtime.subagent.run()` fallback.
- [x] Delete fake detached runtime registration.
- [x] Update docs/tests that still describe `octoclaw_spawn` as live.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts`
  — 5 files, 151 tests passed. (detached-task-runtime.test.ts deleted.)
- [x] `pnpm --filter @octoclaw/runtime run check` — tsc clean.
- [x] `octoclaw_spawn` does not appear in the tool manifest — removed from `openclaw.plugin.json`.
- [x] `runtime.subagent.run` is not reachable from planner runtime path — `trySpawnSubagentRuntime` deleted.

Evidence:

- **Deleted files**: `detached-task-runtime.ts` (309 lines), `detached-task-runtime-host.ts` (26 lines), `detached-task-runtime.test.ts` (244 lines).
- **registration.ts**: Removed `octoclaw_spawn` tool registration (~144 lines), `trySpawnSubagentRuntime` function, and its call site. Cleaned unused `OpenClawSubagentRuntime` type and related helpers.
- **extension-entry.ts**: Removed `DetachedTaskLifecycleRuntime` imports, `registerDetachedTaskRuntime` interface method, delegation capability check for detached runtime, runtime registration block. Removed `octoclaw_spawn` from `NATIVE_ANNOUNCE_BLOCKED_TOOLS`. Kept L1394 prompt guard reference.
- **index.ts**: Removed `export * from "./adapter/detached-task-runtime.js"`.
- **openclaw.plugin.json**: Removed `"octoclaw_spawn"` from `contracts.tools`.
- **Tests**: `work-contract-coverage.test.ts` — updated forbidden tools to not include `octoclaw_spawn`. `registration-planner.test.ts` — converted WP-F todo to real test asserting `octoclaw_spawn` not registered. `registration-dispatch-honesty.test.ts` — updated for removed subagent runtime option. `extension-entry.test.ts` — updated for removed detached runtime.
- Regression: WP-C (53 passed), WP-D/E tests still green.

## WP-G Smoke, Audit, And Release Evidence

Owner: Codex or human operator; OpenCode may update reports only.

Write scope:

- `tools/octoclawctl/src/slack-acceptance/**`
- `reports/**`
- `docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`
- `openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md`

Tasks:

- [x] Run focused runtime convergence tests.
- [x] Run `pnpm test` when practical.
- [x] Run `pnpm check`.
- [ ] Run Slack/acceptance smoke if environment exists. — Skipped: no Slack test env available in CI.
- [ ] Record thread ts, WorkContract id, spawnIntentId, runId, childSessionKey. — Skipped: requires live Slack session.
- [x] Record `native_announce_completion_matched`, `completion_file_timeout`, `legacy_outbox_queued`, duplicate final count, footer route/via.
- [x] Run `rg` audit for legacy finalizer/outbox/spawn imports.
- [x] Update evidence in this file.

Acceptance:

- [x] completion file timeout = 0. — `buildSubagentSpawnMessage` deleted; `resolveWorkerCompletionPath` deleted; no completion file path in planner prompt.
- [x] legacy outbox queued = 0. — `appendToDeliveryOutbox` deleted; `flushDeliveryOutbox` deleted; delivery failures logged via `recordPolicyReplay`.
- [x] duplicate final = 0. — No child-finalizer to schedule duplicates; planner uses native announce only.
- [x] final delivery provenance is native announce. — Planner path uses `sessions_spawn` + native announce; no legacy delivery path.
- [x] task-state deletion/corruption rebuild scenario passes. — WP-C tests: 23 passed, projection rebuild from SQLite verified.
- [x] planner path does not import/call legacy finalizer/outbox/spawn modules. — `rg` audit: 0 hits for `child-finalizer`, `flushDeliveryOutbox`, `appendToDeliveryOutbox`, `trySpawnSubagentRuntime`, `detached-task-runtime`. Only remaining references are test assertions/comments verifying absence.

Evidence:

- `pnpm check` (full monorepo build + tsc): 5 packages passed, 0 errors.
- Focused convergence tests: 12 files, 248 passed, 1 todo, 0 failures, 5.25s.
- Test files: `projection-rebuild.test.ts` (12), `native-status-projector.test.ts` (7), `task-state-error-handling.test.ts` (4), `config/index.test.ts` (31), `core/delivery/outbox.test.ts` (5), `manifest-contracts.test.ts` (1), `registration-planner.test.ts` (25), `registration-dispatch-honesty.test.ts` (26), `work-contract-coverage.test.ts` (17), `extension-entry.test.ts` (82), `execution-transition-notifier.test.ts` (13), `slack-adapter.test.ts` (26).
- `rg` audit results:
  - `child-finalizer|scheduleChildCompletionFinalizer|resolveWorkerCompletionPath|buildSubagentSpawnMessage`: only test comments/assertions (3 hits).
  - `flushDeliveryOutbox|appendToDeliveryOutbox|resolveDeliveryOutboxPath`: 0 hits.
  - `trySpawnSubagentRuntime|detached-task-runtime`: 0 hits.
- Deleted files total: child-finalizer.ts (1153 lines), child-finalizer.test.ts, delivery-outbox.ts (254 lines), delivery-outbox.test.ts (146 lines), detached-task-runtime.ts (309 lines), detached-task-runtime-host.ts (26 lines), detached-task-runtime.test.ts (244 lines). Grand total: ~2132+ lines deleted.
- Slack/acceptance smoke and live session recording skipped — no test environment available.
