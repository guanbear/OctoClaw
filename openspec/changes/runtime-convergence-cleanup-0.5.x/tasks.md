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

- [ ] Add or update tests proving planner prompt does not require completion file in target mode.
- [ ] Add or update tests proving planner path does not schedule child finalizer in target mode.
- [ ] Add or update tests proving planner path does not queue delivery outbox in target mode.
- [ ] Add or update tests documenting `octoclaw_spawn` as a delete target, not a compatibility alias.
- [ ] Add or update tests documenting SQLite metadata ledger as the target default.
- [ ] Record current gaps as explicit failing/todo tests if not fixed in this WP.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`

Evidence:

- Pending.

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

- [ ] Make runtime ledger default `metadata` or enforce-equivalent.
- [ ] Make `saveWorkContract()` write SQLite first and projection second.
- [ ] Make `loadWorkContract()` read SQLite by default.
- [ ] Make `listWorkContractsBySession()` read SQLite by default.
- [ ] Move task-state backfill into explicit migration/import path.
- [ ] Emit degraded/backfill diagnostics for task-state import and SQLite failures.
- [ ] Prove SQLite unavailable does not silently return empty task list.
- [ ] Document `native_spawn_intents` as an auxiliary planner table.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/runtime-ledger.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts extensions/octoclaw-runtime/src/work-contract/store.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] Code search shows task-state WorkContract reads are migration/import only.

Evidence:

- Pending.

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

- [ ] Introduce or converge `StatusProjectionBuilder`.
- [ ] Replace direct status/details task-state truth reads.
- [ ] Replace conversation grounding task-state truth reads.
- [ ] Replace ACK/watchdog task-state truth reads.
- [ ] Make missing task-state rebuild safe by default.
- [ ] Make corrupt task-state quarantine and rebuild safe by default.
- [ ] Make IO errors fail closed without overwriting the file.
- [ ] Emit projection degraded/rebuilt markers.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts extensions/octoclaw-runtime/src/ack/ack-guard.test.ts extensions/octoclaw-runtime/src/conversation-grounding.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] Deleting `task-state.json` does not erase durable status truth.
- [ ] Corrupting `task-state.json` produces quarantine/degraded marker.

Evidence:

- Pending.

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

- [ ] Remove completion file path/template/requirement from planner child prompt.
- [ ] Remove planner completion binding creation as normal completion gate.
- [ ] Remove planner `scheduleChildCompletionFinalizer()` call.
- [ ] Remove child-finalizer recovery startup registration.
- [ ] Remove `OCTOCLAW_LEGACY_COMPLETION_FILE` product config.
- [ ] Convert old completion/finalizer tests to import-only migration tests or delete them.
- [ ] Add native announce test proving no completion timeout.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] `rg "MUST write the result to this file|resolveWorkerCompletionPath|scheduleChildCompletionFinalizer" extensions/octoclaw-runtime/src/tools/registration.ts` does not hit planner path.

Evidence:

- Pending.

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

- [ ] Remove startup `flushDeliveryOutbox()` interval.
- [ ] Remove normal `queueOutboxDelivery()` call sites.
- [ ] Record delivery failure as SQLite/replay/projection pending/degraded.
- [ ] Stop writing outbox files for new runtime.
- [ ] Move historical outbox reading to import-only code if still needed.
- [ ] Add tests proving native planner path produces no outbox entry.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts extensions/octoclaw-runtime/src/core/delivery/outbox.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] Code search shows no new runtime `flushDeliveryOutbox` or `queueOutboxDelivery` call.

Evidence:

- Pending.

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

- [ ] Delete `octoclaw_spawn` tool registration.
- [ ] Delete independent `octoclaw_spawn` model/policy path.
- [ ] Remove `octoclaw_spawn` from tool policy/system prompt allowlists.
- [ ] Make old calls fail fast with `octoclaw_dispatch` guidance.
- [ ] Delete planner backend `runtime.subagent.run()` fallback.
- [ ] Delete fake detached runtime registration.
- [ ] Update docs/tests that still describe `octoclaw_spawn` as live.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/adapter/detached-task-runtime.test.ts extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts`
- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] `octoclaw_spawn` does not appear in the tool manifest.
- [ ] `runtime.subagent.run` is not reachable from planner runtime path.

Evidence:

- Pending.

## WP-G Smoke, Audit, And Release Evidence

Owner: Codex or human operator; OpenCode may update reports only.

Write scope:

- `tools/octoclawctl/src/slack-acceptance/**`
- `reports/**`
- `docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`
- `openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md`

Tasks:

- [ ] Run focused runtime convergence tests.
- [ ] Run `pnpm test` when practical.
- [ ] Run `pnpm check`.
- [ ] Run Slack/acceptance smoke if environment exists.
- [ ] Record thread ts, WorkContract id, spawnIntentId, runId, childSessionKey.
- [ ] Record `native_announce_completion_matched`, `completion_file_timeout`, `legacy_outbox_queued`, duplicate final count, footer route/via.
- [ ] Run `rg` audit for legacy finalizer/outbox/spawn imports.
- [ ] Update evidence in this file.

Acceptance:

- [ ] completion file timeout = 0.
- [ ] legacy outbox queued = 0.
- [ ] duplicate final = 0.
- [ ] final delivery provenance is native announce.
- [ ] task-state deletion/corruption rebuild scenario passes.
- [ ] planner path does not import/call legacy finalizer/outbox/spawn modules.

Evidence:

- Pending.
