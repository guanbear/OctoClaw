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

- [ ] Add or confirm BDD scenarios `NFSV2-*` from the OpenSpec BDD file.
- [ ] Add a failing regression test proving route hint is advisory by default and does not block `octoclaw_dispatch`.
- [ ] Add a failing regression test proving budgeted-main tool escalation allows the following `octoclaw_dispatch`.
- [ ] Add a failing projection test proving stale task-state terminal cache cannot override native running/completed status.
- [ ] Add a failing footer test proving final result footer is compact by default while ACK/status card sends remain off.
- [ ] Run targeted tests and confirm the new tests fail for the expected reason:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
```

Expected: only newly added guard tests fail.

## Task 2: Make Advanced Defaults Explicit

**Files:**
- Modify: `extensions/octoclaw-runtime/src/config/index.ts`
- Modify: `extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-prompt-build.ts`
- Test: `extensions/octoclaw-runtime/src/config/index.test.ts`
- Test: `extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.test.ts`

- [ ] Run GitNexus impact analysis for every edited resolver/config symbol.
- [ ] Add tests for defaults:
  - speculative preload remains default-off through `resolveSpeculativePreloadEnabled()`
  - route hint hard precondition default-off
  - automatic retry/amendment/respawn default-off if such automation exists
  - explicit `octoclaw_task_action retry` still works
  - wall-time escalation default observation-only
  - final result footer default compact, non-final sends off
- [ ] Implement or adjust config defaults without changing advanced opt-in behavior.
- [ ] If a needed advanced flag does not exist, add one named in the design rather than overloading route hints or WorkContract fields.
- [ ] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/config/index.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-routing-helpers.test.ts
```

Expected: defaults are explicit and advanced opt-in tests still pass.

## Task 3: Convert Wall-Time Budget to Default Observation

**Files:**
- Modify: `extensions/octoclaw-runtime/src/budgeted-main.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/budgeted-main.test.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`

- [ ] Run GitNexus impact analysis for `scheduleBudgetedMainTimeout`, `maybeStartBudgetedMain`, `escalateBudgetedMainForTool`, and any edited hook symbol.
- [ ] Add tests:
  - timeout records observation/pending evidence only under default config
  - timeout does not mutate route to delegate by itself under default config
  - tool-risk escalation still blocks the risky ordinary tool
  - a subsequent `octoclaw_dispatch` is admitted with budget evidence
- [ ] Implement default observation-only wall-time behavior.
- [ ] Preserve advanced opt-in wall-time escalation behind a named config flag if existing behavior must remain available.
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

- [ ] Run GitNexus impact analysis for `buildTaskStatusProjection` and runtime status projection builders.
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

- [ ] Run GitNexus impact analysis for `projectionFooterMode`, `replyProjectionFooterEnabled`, and edited adapter footer functions.
- [ ] Add tests:
  - final assistant result gets compact footer by default when evidence exists
  - neutral ACK sends keep `footerMode=off`
  - status cards keep `footerMode=off`
  - native announce footer requires final native delivery evidence
  - delegate compact footer requires accepted dispatch/spawn/native evidence, not only cache booleans
  - debug-only IDs do not appear in compact mode
- [ ] Update footer types only as needed. If IM adapter `footerMode` gains `compact`, verify Slack/Telegram/Discord behavior.
- [ ] Use a sanitized compact footer projection for compact mode. Do not pass debug fields and rely on adapters to drop them.
- [ ] Verify targeted tests.

## Task 5: Add Shared Tool Gate Interface

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/tool-gate-types.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/tool-gate-types.test.ts`

- [ ] Define `ToolGateInput`, `ToolGateResult`, `ToolGateReplayEvent`, and helper constructors for `allow`, `block`, and `observe`.
- [ ] Ensure gate result can carry state patches and replay events without each gate importing the full hook orchestrator.
- [ ] Verify:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/hooks/tool-gate-types.test.ts
```

Expected: type/helper tests pass.

## Task 6: Extract SessionControlGate

**Files:**
- Create: `extensions/octoclaw-runtime/src/hooks/session-control-gate.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/session-control-gate.test.ts`
- Test: `extensions/octoclaw-runtime/src/regression-round4.test.ts`

- [ ] Run GitNexus impact analysis for `makeBeforeToolCallHook` and helper symbols being moved.
- [ ] Move native announce delivery block and session/status/provenance control checks into `SessionControlGate`.
- [ ] Preserve behavior:
  - native announce completion blocks duplicate dispatch/spawn
  - status/provenance follow-up does not start new work
  - `octoclaw_status` and `octoclaw_task_action` bookkeeping remains
- [ ] Verify targeted tests.

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

- [ ] Ensure `before-tool-call.ts` only orchestrates gates and shared side effects.
- [ ] Confirm gate order is:
  - `SessionControlGate`
  - `NativeSpawnGate` runner
  - `BudgetedMainGate`
  - `RouteHintGate`
  - `DelegationWorkflowGuard`
- [ ] Record before/after LOC:

```bash
wc -l extensions/octoclaw-runtime/src/hooks/before-tool-call.ts
find extensions/octoclaw-runtime/src/hooks -maxdepth 1 -type f -name '*gate*.ts' -print0 | xargs -0 wc -l
```

- [ ] Run:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
pnpm check
```

Expected: targeted suites and typecheck pass.

## Task 12: Full Verification and Closeout

**Files:**
- Modify: `openspec/changes/native-first-slimming-v2-0.6.x/tasks.md`
- Modify: implementation notes if created by worker

- [ ] Run full test suite:

```bash
pnpm test
pnpm check
git diff --check
npx gitnexus detect-changes --repo OctoClaw
```

- [ ] Confirm BDD scenarios in `openspec/changes/native-first-slimming-v2-0.6.x/bdd.md` are covered by tests.
- [ ] Confirm no advanced feature became default-on.
- [ ] Confirm no new lifecycle engine or runner pool was introduced.
- [ ] Confirm `NativeSpawnGate` still blocks missing/mismatched spawn intent.
- [ ] Commit only expected files.
