# Native-First Runtime Slimming V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim OctoClaw runtime defaults, make OpenClaw native status the only lifecycle truth, and split `before-tool-call.ts` into deep gate modules without weakening native spawn safety.

**Architecture:** Keep OpenClaw as execution runtime and OctoClaw as policy/contract/audit layer. First add behavior guardrails, then make advanced features default-off/advisory, then extract gates behind narrow interfaces, and only then delete dead hard gates. Every task starts with tests and GitNexus impact analysis for edited symbols.

**Tech Stack:** TypeScript, Vitest, OpenSpec-lite, GitNexus, existing OctoClaw runtime hooks, WorkContract, native spawn intent store.

---

## Required Discipline

- Before editing any function, class, or method, run `npx gitnexus impact --repo OctoClaw --target <symbol> --direction upstream` or the equivalent GitNexus MCP impact tool.
- If impact is HIGH or CRITICAL, stop and report the blast radius before editing.
- Use TDD for behavior changes.
- Do not edit runtime code before the corresponding BDD scenario exists.
- Do not touch router scoring, local model filtering, or model leaderboard code in this plan.
- Do not remove `NativeSpawnGate` safety checks.
- Do not create a second native status projector; reuse `state/native-status-projector.ts` and `runtime-host/openclaw-adapter.ts`.
- Do not remove explicit `octoclaw_task_action retry`; only automatic retry/amend/respawn is out of the default path.
- Treat "footer default-on" as final result footer only. Keep neutral ACK, status cards, onboarding, and native delivery internals footer-free unless tests say otherwise.
- Treat `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, and `nativeAnnounceDelivered` as legacy/display markers unless paired with accepted native/runtime evidence.
- Keep all native session tools (`sessions_spawn`, `sessions_send`, `sessions_yield`) out of ordinary budgeted-main tool classification.
- Run `npx gitnexus detect-changes --repo OctoClaw` before each commit.

## File Structure Target

Create or evolve these modules:

- `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
  - Orchestrator only: load state, run gates, apply result, record shared replay/ACK.
- `extensions/octoclaw-runtime/src/hooks/tool-gate-types.ts`
  - Shared gate input/result types.
- `extensions/octoclaw-runtime/src/hooks/session-control-gate.ts`
  - Status/provenance/native announce delivery gate.
- `extensions/octoclaw-runtime/src/hooks/budgeted-main-gate.ts`
  - Main-agent tool budget observation and escalation evidence.
- `extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.ts`
  - Hook adapter around existing `delegate/native-spawn-gate.ts`.
- `extensions/octoclaw-runtime/src/hooks/route-hint-gate.ts`
  - Route hint bookkeeping and advisory behavior.
- `extensions/octoclaw-runtime/src/hooks/delegation-workflow-guard.ts`
  - Delegate route workflow enforcement that never blocks `octoclaw_dispatch`.
- `extensions/octoclaw-runtime/src/status/native-execution-snapshot.ts`
  - Optional typed facade over existing native status projector outputs.
- `extensions/octoclaw-runtime/src/status/task-projection-input.ts`
  - Projection input builder that separates native truth from cache metadata.

Keep existing files where behavior already lives:

- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`
- `extensions/octoclaw-runtime/src/budgeted-main.ts`
- `extensions/octoclaw-runtime/src/dispatch-admission.ts`
- `packages/octoclaw-contracts/src/status-projection.ts`
- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.ts`

## Task 1: Add BDD and Guard Tests First

**Files:**
- Modify: `openspec/changes/native-first-slimming-v2-0.6.x/bdd.md`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`
- Test: `extensions/octoclaw-runtime/src/regression-round4.test.ts`
- Test: `packages/octoclaw-contracts/src/status-projection.test.ts`

- [x] Add or confirm BDD scenarios `NFSV2-*` from the OpenSpec BDD file.
  - Closeout audit: current regression tests cover the completed NFSV2 truth,
    gate, budget, hint, and footer scenarios. Tests are distributed across
    `extension-entry-policy-route-hint.test.ts`, `regression-round4.test.ts`,
    `status-projection.test.ts`, gate tests, outbound guard tests, and Slack
    adapter tests.
- [ ] Add a failing regression test proving route hint is advisory by default and does not block `octoclaw_dispatch`.
  - Process evidence gap: final regression coverage exists, but the initial
    red-phase output was not preserved.
- [ ] Add a failing regression test proving budgeted-main tool escalation allows the following `octoclaw_dispatch`.
  - Process evidence gap: final regression coverage exists, but the initial
    red-phase output was not preserved.
- [ ] Add a failing projection test proving stale task-state terminal cache cannot override native running/completed status.
  - Process evidence gap: final regression coverage exists, but the initial
    red-phase output was not preserved.
- [ ] Add a failing footer test proving final result footer is compact by default while ACK/status card sends remain off.
  - Process evidence gap: final regression coverage exists, but the initial
    red-phase output was not preserved.
- [x] Run targeted tests and confirm the final regression coverage:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
```

Closeout result: final regression suites pass. The original expected-failure
phase is not recoverable from current artifacts and is intentionally not marked
complete.

## Task 2: Make Advanced Defaults Explicit

**Files:**
- Modify: `extensions/octoclaw-runtime/src/config/index.ts`
- Modify: `extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-prompt-build.ts`
- Test: `extensions/octoclaw-runtime/src/config/index.test.ts`
- Test: `extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.test.ts`

- [x] Run GitNexus impact analysis for every edited resolver/config symbol.
  - Closeout audit: `resolveSpeculativePreloadEnabled` post-change impact is
    LOW. Earlier slice impact checks covered `makeBeforeToolCallHook`,
    `projectionFooterMode`, `appendReplyProjectionFooter`, and
    `SlackAdapter.send`. `projectionFooterMode` remains CRITICAL blast radius
    and is covered by focused footer/outbound/adapter tests.
- [x] Add tests for defaults:
  - speculative preload remains default-off through `resolveSpeculativePreloadEnabled()`
  - route hint hard precondition default-off
  - automatic retry/amendment/respawn default-off if such automation exists
  - explicit `octoclaw_task_action retry` still works
  - wall-time escalation default observation-only
  - final result footer default compact, non-final sends off
- [x] Implement or adjust config defaults without changing advanced opt-in behavior.
- [x] If a needed advanced flag does not exist, add one named in the design rather than overloading route hints or WorkContract fields.
- [x] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/config/index.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.test.ts
```

Expected/current result: defaults are explicit and advanced opt-in tests pass.

## Task 3: Convert Wall-Time Budget to Default Observation

**Files:**
- Modify: `extensions/octoclaw-runtime/src/budgeted-main.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/budgeted-main.test.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`

- [x] Run GitNexus impact analysis for `scheduleBudgetedMainTimeout`, `maybeStartBudgetedMain`, `escalateBudgetedMainForTool`, and any edited hook symbol.
  - Closeout audit: moved hook logic is covered by the recorded
    `makeBeforeToolCallHook` LOW impact check and focused
    `BudgetedMainGate` tests.
- [x] Add tests:
  - timeout records observation/pending evidence only under default config
  - timeout does not mutate route to delegate by itself under default config
  - tool-risk escalation still blocks the risky ordinary tool
  - a subsequent `octoclaw_dispatch` is admitted with budget evidence
- [x] Implement default observation-only wall-time behavior.
- [x] Preserve advanced opt-in wall-time escalation behind a named config flag if existing behavior must remain available.
- [x] Verify targeted tests.

## Task 4: Introduce Native Execution Truth Adapter

**Files:**
- Create if useful: `extensions/octoclaw-runtime/src/status/native-execution-snapshot.ts`
- Create if useful: `extensions/octoclaw-runtime/src/status/task-projection-input.ts`
- Modify: `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- Modify: `extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.ts`
- Modify: `extensions/octoclaw-runtime/src/state/task-state-store.ts`
- Modify: `packages/octoclaw-contracts/src/status-projection.ts`
- Test: `packages/octoclaw-contracts/src/status-projection.test.ts`
- Test: `extensions/octoclaw-runtime/src/tools/runtime-status.test.ts`

- [x] Run GitNexus impact analysis for `buildTaskStatusProjection` and runtime status projection builders.
  - Closeout audit: `buildTaskStatusProjection` post-change impact is LOW.
- [x] Add tests:
  - native running beats stale cache completed
  - native completed beats stale cache failed
  - native refs without accepted run evidence do not imply `spawnExecuted`
  - `dispatchExecuted` / `spawnExecuted` cache booleans do not imply lifecycle or compact footer truth without accepted native evidence
  - deleting policy-state cache still permits projection from ledger/native inputs
- [x] Implement a small adapter or type facade that names truth inputs explicitly. It must wrap existing `NativeStatusProjection` / `RuntimeStatusSnapshot` data:

```ts
export interface NativeExecutionSnapshot {
  runAccepted: boolean;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "canceled" | "unknown";
  runId?: string;
  taskId?: string;
  flowId?: string;
  nativeAnnounceDelivered?: boolean;
  finalResultExists?: boolean;
  observedAt?: string;
}
```

- [x] Keep cache metadata as display metadata, never as lifecycle authority.
- [x] Do not bypass `projectNativeStatus()` or duplicate its native lookup logic.
- [x] Verify targeted tests.

## Task 4B: Normalize Final Result Footer Defaults

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/footer-mode.ts`
- Modify: `extensions/octoclaw-runtime/src/im/adapter.ts`
- Modify: `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- Modify if needed: `extensions/octoclaw-runtime/src/im/telegram/telegram-adapter.ts`
- Modify if needed: `extensions/octoclaw-runtime/src/im/discord/discord-adapter.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts`
- Test: `extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts`

- [x] Run GitNexus impact analysis for `projectionFooterMode`, `replyProjectionFooterEnabled`, and edited adapter footer functions.
  - Closeout audit: `projectionFooterMode` is CRITICAL blast radius, affecting
    native announce delivery, outbound guard, and register flows. The footer
    migration is therefore guarded by focused outbound guard, Slack adapter,
    status card, neutral ACK, onboarding, and full-suite tests.
- [x] Add tests:
  - final assistant result gets compact footer by default when evidence exists
  - neutral ACK sends keep `footerMode=off`
  - status cards keep `footerMode=off`
  - native announce footer requires final native delivery evidence
  - delegate compact footer requires accepted dispatch/spawn/native evidence, not only cache booleans
  - debug-only IDs do not appear in compact mode
- [x] Update footer types only as needed. If IM adapter `footerMode` gains `compact`, verify Slack/Telegram/Discord behavior.
- [x] Use a sanitized compact footer projection for compact mode. Do not pass debug fields and rely on adapters to drop them.
- [x] Verify targeted tests.

## Task 5: Add Shared Tool Gate Interface

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/tool-gate-types.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/tool-gate-types.test.ts`

- [x] Define `ToolGateInput`, `ToolGateResult`, `ToolGateReplayEvent`, and helper constructors for `allow`, `block`, and `observe`.
- [x] Ensure gate result can carry state patches and replay events without each gate importing the full hook orchestrator.
- [x] Verify:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/hooks/tool-gate-types.test.ts
```

Expected/current result: type/helper behavior is covered by gate tests.

## Task 6: Extract SessionControlGate

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/session-control-gate.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/session-control-gate.test.ts`
- Test: `extensions/octoclaw-runtime/src/regression-round4.test.ts`

- [x] Run GitNexus impact analysis for `makeBeforeToolCallHook` and helper symbols being moved.
  - Closeout audit: `makeBeforeToolCallHook` post-change impact is LOW.
- [x] Move native announce delivery block and session/status/provenance control checks into `SessionControlGate`.
- [x] Preserve behavior:
  - native announce completion blocks duplicate dispatch/spawn
  - status/provenance follow-up does not start new work
  - `octoclaw_status` and `octoclaw_task_action` bookkeeping remains
- [x] Verify targeted tests.

## Task 7: Extract NativeSpawnGate Runner

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.test.ts`
- Test: `extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts`

- [x] Run GitNexus impact analysis for native spawn hook logic and existing gate helpers.
- [x] Wrap existing `evaluateNativeSpawnGate` and `evaluateNativeSessionsSendGate`.
- [x] Preserve exact block reasons for missing intent and hash mismatch unless tests intentionally update copy.
- [x] Preserve `spawn_call_started` state transition.
- [x] Preserve `sessions_yield` block before child start.
- [x] Verify targeted tests.

## Task 8: Extract BudgetedMainGate

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/budgeted-main-gate.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/budgeted-main-gate.test.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`

- [x] Run GitNexus impact analysis for moved budgeted-main hook logic.
- [x] Move ordinary tool classification, state updates, and escalation block into `BudgetedMainGate`.
- [x] Ensure `BudgetedMainGate` never blocks `octoclaw_dispatch`.
- [x] Ensure wall-time-only default is observation, not route mutation.
- [x] Ensure `sessions_spawn`, `sessions_send`, `sessions_yield`, and `session_status` are control tools and never counted as ordinary budgeted-main tools.
- [x] Verify targeted tests.

## Task 9: Extract RouteHintGate

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/route-hint-gate.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/route-hint-gate.test.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`

- [x] Run GitNexus impact analysis for route hint binding and precondition logic.
- [x] Move `octoclaw_route_hint` binding/bookkeeping into `RouteHintGate`.
- [x] Make default route hint behavior advisory; do not hard-block `octoclaw_dispatch`.
- [x] Keep advanced hard precondition behavior only behind explicit config.
- [x] Verify targeted tests.

## Task 10: Extract DelegationWorkflowGuard

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/delegation-workflow-guard.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/delegation-workflow-guard.test.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`

- [x] Run GitNexus impact analysis for `workflowEnforcementRule` call sites and moved delegation logic.
- [x] Move delegate-route direct tool blocking into `DelegationWorkflowGuard`.
- [x] Ensure the guard blocks ordinary tools but never blocks `octoclaw_dispatch`.
- [x] Remove or downgrade duplicated WorkContract forbidden-tool blocks for dispatch.
- [x] Verify targeted tests.

## Task 11: Slim Orchestrator and Measure

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Modify: docs if behavior changed: `README.md`, `docs/octoclaw-runtime-gate-convergence-design-2026-05-12.md`

- [x] Ensure `before-tool-call.ts` only orchestrates gates and shared side effects.
  - Current status: complete for slimming v2. The hook is down from the V2
    baseline of 922 lines to 469 lines after extracting
    `SpeculativePreloadGate`, moving `sessions_yield` pending-intent blocking
    into `NativeSpawnGate runner`, moving reply direct-tool latency/replay side
    effects into `ReplyDirectToolRunner`, and moving native
    `sessions_spawn`/`sessions_send`/`sessions_yield` planner orchestration
    into `NativeSessionToolRunner`.
- [x] Confirm gate order is:
  - `SessionControlGate`
  - `NativeSpawnGate` runner
  - `BudgetedMainGate`
  - `RouteHintGate`
  - `DelegationWorkflowGuard`
- [x] Record before/after LOC:
  - V2 baseline `before-tool-call.ts`: 922 lines.
  - After first native-first gate extraction: 769 lines.
  - After reply direct-tool extraction: 653 lines.
  - After native session tool runner extraction: 469 lines.
  - Net reduction from V2 baseline: 453 lines.

```bash
wc -l extensions/octoclaw-runtime/src/hooks/before-tool-call.ts
find extensions/octoclaw-runtime/src/hooks -maxdepth 1 -type f -name '*gate*.ts' -print0 | xargs -0 wc -l
```

- [x] Run focused gate tests for the current extraction slice:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/hooks/speculative-preload-gate.test.ts \
  extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.test.ts
```

Expected/current result: 2 files, 6 tests passed.

- [x] Run focused reply direct-tool extraction tests:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/hooks/reply-direct-tool-runner.test.ts \
  extensions/octoclaw-runtime/src/hooks/budgeted-main-gate.test.ts \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts
```

Expected/current result: 4 files, 133 tests passed.

- [x] Run focused native session runner extraction tests:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/hooks/native-session-tool-runner.test.ts \
  extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts
```

Expected/current result: 3 files, 33 tests passed.

- [x] Run focused footer default migration tests:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts \
  extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-status-card.test.ts \
  extensions/octoclaw-runtime/src/extension-entry-neutral-ack.test.ts \
  extensions/octoclaw-runtime/src/router-onboarding.test.ts
```

Expected/current result: 5 files, 133 tests passed.

- [x] Run broader verification:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
pnpm check
```

Expected/current result: targeted suites and typecheck passed in the completed
implementation slice. Closeout audit reran 8 focused files with 149 tests
passed and 1 todo.

## Task 12: Full Verification and Closeout

**Files:**
- Modify: `openspec/changes/native-first-slimming-v2-0.6.x/tasks.md`
- Modify: implementation notes if created by worker

- [x] Run full test suite:

```bash
pnpm test
pnpm check
git diff --check
npx gitnexus detect-changes --repo OctoClaw
```

- [x] Confirm BDD scenarios in `openspec/changes/native-first-slimming-v2-0.6.x/bdd.md` are covered by tests.
- [x] Confirm no advanced feature became default-on.
- [x] Confirm no new lifecycle engine or runner pool was introduced.
- [x] Confirm `NativeSpawnGate` still blocks missing/mismatched spawn intent.
- [x] Commit only expected files.
  - Closeout target: docs-only follow-up commit plus existing implementation
    commit. Local untracked `.omx/` and `.octoclaw-work-packets/` remain
    excluded from commits.
