# OctoClaw Phase 1 Stabilization Design

Date: 2026-04-29
Branch: `refactor/0.4.0-stable`
Source contract: `docs/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md` Phase 1

## Goal

Make Phase 1 real, not just test-green:

- `octoclaw_status` and IM messages project the same task truth.
- OpenClaw restart does not lose task state.
- IM delivery has a retry path instead of best-effort fire-and-forget.
- Delegate progress uses event transitions, not tier1/2/3 “still running” nudges.
- Missing thread anchors degrade to top-level IM messages, never silent skips.
- `replay-logger.ts` is fully split; delivery relay is removed from live and grounding paths.

## Non-Goals

- Do not start Phase 2 package/workspace consolidation here.
- Do not reintroduce remote judge or dual judge.
- Do not use raw child transcripts for parent result projection.
- Do not make `policyState` a persistent task ledger again.
- Do not make dispatch truth depend on classifier keywords or route-hint text alone.

## Truth Model

Phase 1 must preserve the 4.4 state convergence rule:

1. Native TaskFlow is execution lifecycle truth.
2. WorkContract is semantic/delegation/handoff/continuity truth.
3. `task-state.json` is the canonical durable projection used by tools, IM, and restart recovery.
4. `policyState` is a short-lived turn/hook cache only.

Consequence: if a user-visible status needs to survive restart, it must be written to `task-state.json` before it is projected to IM or `octoclaw_status`.

## Current Gaps

### Gap A: Delivery outbox is not a real module

Current state:

- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts` has inline `queueOutboxDelivery`.
- There is no `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`.
- There is no runtime flush/watchdog loop for queued IM deliveries.

Problem:

- Final result delivery can be queued, but there is no clear bounded retry lifecycle.
- Delivery behavior is not reusable by progress/final paths.

### Gap B: Status still falls back to `policyState`

Current state:

- `octoclaw_status` reads `task-state.json`, but also synthesizes runtime tasks from `policyState.entries()` when no task-state record exists.

Problem:

- That fallback violates restart durability: after restart the same status can disappear.
- It weakens the rule that `spawnExecuted` and `resultMaterialized` must come from durable evidence.

### Gap C: ACK/Progress is only partially unified

Current state:

- Delegate/observe tier timers are disabled in `ack-timing.ts`.
- `ack-decision.ts` still owns a separate `ACK_TIMING` constant and tier decision logic.
- `sendAckDirectDetailed` and `sendExecutionTransitionDirect` still carry “direct” naming and target pre-resolution logic.

Problem:

- Two timing definitions can drift again.
- Delegate progress can accidentally regress into tier nudge behavior.
- Thread-anchor failure semantics are not centralized in `sendIMMessage`.

### Gap D: Replay split is incomplete

Current state:

- `receipt.ts`, `replay/replay.ts`, `replay/message-guard.ts`, and `replay/policy-utils.ts` exist.
- `replay/replay-logger.ts` remains as a compatibility re-export.
- Many imports still point to `replay-logger.ts`.
- `conversation-grounding.ts` still builds a delivery relay index.

Problem:

- The “God file” is structurally thinner but still the public dependency hub.
- Delivery relay still influences grounding, contrary to the Phase 1 acceptance target.

## Target Architecture

### 1. IM Adapter + Delivery Service

Keep the IM adapter registry:

- `extensions/octoclaw-runtime/src/im/adapter.ts`
- `extensions/octoclaw-runtime/src/im/index.ts`
- `extensions/octoclaw-runtime/src/im/send.ts`

Add runtime delivery service:

- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts`

`sendIMMessage` remains the only low-level sender. It should own adapter lookup and should not require callers to pre-resolve Slack/OpenClaw thread internals.

Required delivery API:

```ts
export interface DeliveryOutboxEntry {
  id: string;
  workContractId: string;
  kind: "final_result" | "progress" | "ack";
  parentSessionKey: string;
  replyToMessageId?: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextRetryAt: string;
  lastError?: string;
}

export function readDeliveryOutbox(path?: string): DeliveryOutboxEntry[];
export function appendToDeliveryOutbox(entry: AppendDeliveryOutboxInput, path?: string): DeliveryOutboxEntry;
export function removeDeliveryOutboxEntry(id: string, path?: string): void;
export async function flushDeliveryOutbox(options?: FlushDeliveryOutboxOptions): Promise<FlushDeliveryOutboxResult>;
```

Retry policy:

- Initial retry: 30 seconds.
- Backoff: 30s, 60s, 120s, 300s, capped at 5 minutes.
- Keep entries until delivered or max attempts is reached.
- Write every mutation atomically.
- Use stable entry ids: `workContractId:kind:hash(parentSessionKey, replyToMessageId, message)` to prevent duplicate queue spam.

Callers:

- `child-finalizer.ts`: replace inline `queueOutboxDelivery` with `appendToDeliveryOutbox` for final results.
- `execution-transition-notifier.ts`: progress transitions are best-effort, but if adapter is temporarily unavailable and transition is important (`dispatch_materialized`, `spawn_started`, `timed_out`, `result_ready`), queue as `kind="progress"`.
- ACK messages should not normally be queued because stale ACKs are harmful. They may record replay, but not outbox retry.

Flush triggers:

- Register a low-frequency timer in `extension-entry.ts` when runtime is enabled.
- Flush once on startup/register.
- Flush after a final-result queue write by scheduling a non-blocking short retry.
- Never block `before_prompt_build` or `before_tool_call` on outbox flush.

Task-state coupling:

- When final result is queued: update the same task-state record with `delivery.status="queued_for_retry"`.
- When flush succeeds: update task-state to `delivery.status="delivered"`, `delivery.messageId`, `delivery.deliveredAt`.
- When retries fail: update `delivery.status="retry_pending"` or `delivery.status="failed"` with last error.

### 2. Canonical Status Projection

`octoclaw_status` must read durable state only:

- Primary: `readTaskStateRecords()`.
- Optional archive: `readArchivedTaskState()` when the format requests expired/history view.
- No `policyState.entries()` fallback in `buildNativeStatusOutput`.

Required writer rule:

- Every dispatch materialization writes a task-state record.
- Every spawn confirmation updates that record.
- Every timeout/failure/final-result/delivery update goes to that record.
- WorkContract store remains a compatibility API over task-state, not a second ledger.

Allowed `policyState` usage:

- ACK guard short-lived state.
- route-hint/dispatch tool guard within a turn.
- recent prompt correlation before durable task-state exists.

Forbidden `policyState` usage:

- `octoclaw_status` task list synthesis.
- restart recovery source of truth.
- `spawnExecuted` or `resultMaterialized` projection without durable task-state evidence.

Tests:

- Write a task-state record, clear `policyState`, assert `octoclaw_status` still shows the task.
- Put only `policyState` runtime truth, assert `octoclaw_status` does not show it unless task-state exists.
- Dispatch path test asserts task-state is upserted before success response claims `dispatchExecuted=true`.

### 3. ACK/Progress Three-Phase Model

User-visible IM phases:

1. ACK: fast receipt message/reaction, before judge can block.
2. Progress: event transitions only for delegate/observe.
3. Final: completion-file result summary.

Timing source:

- `ack-timing.ts` owns timing constants.
- `ack-decision.ts` imports from `ack-timing.ts` or a shared `ack-constants.ts`.
- Delete duplicate `ACK_TIMING` definition from `ack-decision.ts`.

Route behavior:

- `reply`: ACK0 and reply-style tier nudges are allowed.
- `delegate` / `observe`: ACK0 only; tier1/2/3 nudges are suppressed. Progress comes from transitions.
- `pre_route`: ACK0 only until route is known. After route updates to delegate/observe, cancel reply-style tier timers.

ACK guard changes:

- Rename `sendAckDirectDetailed` to `sendAckMessage` after it only calls `sendIMMessage`.
- `updateAckGuardDecision` must recalculate route phase and cancel tier timers for delegate/observe.
- No delegate route message should use stale templates such as “还在跑，稍等” from tier timers.

Progress notifier changes:

- Rename `sendExecutionTransitionDirect` to `sendExecutionTransitionMessage`.
- It should call `sendIMMessage` directly.
- If there is a valid session target but no valid reply anchor, send a top-level message with `replyToMessageId=undefined`.
- Record replay outcome as `top_level_fallback`, not `no_valid_thread_anchor` silent skip.
- If there is no IM adapter, queue important progress transitions in delivery outbox.

Tests:

- Delegate route with timers advanced past tier1/2/3 sends no tier nudge.
- Reply route still sends expected ACK behavior.
- Missing thread anchor sends top-level progress message.
- `ack-decision.ts` has no local `ACK_TIMING` definition.

### 4. Replay Split and Delivery Relay Removal

Final file ownership:

- `extensions/octoclaw-runtime/src/receipt.ts`
  - `TurnExecutionReceipt`
  - `buildTurnExecutionReceipt`
- `extensions/octoclaw-runtime/src/replay/replay.ts`
  - `appendJsonl`
  - `recordPolicyReplay`
  - `recordAckReplay`
  - replay event payload types
- `extensions/octoclaw-runtime/src/replay/message-guard.ts`
  - `guardAssistantMessageForPolicyState`
  - assistant-message sanitizers
- `extensions/octoclaw-runtime/src/replay/policy-utils.ts`
  - `preHintAllowedTools`
  - `workflowEnforcementRule`
  - `isDelegatedRoute`
  - compact policy helpers

Migration rule:

- Migrate all imports away from `replay/replay-logger.ts`.
- Delete `replay/replay-logger.ts` after imports are migrated.
- Update `extensions/octoclaw-runtime/src/index.ts` to export the four new modules explicitly.

Delivery relay removal:

- Delete relay fields from grounding facts:
  - `finalDeliveryRelayEvent`
  - `finalDeliveryRelayState`
- Delete `deriveDeliveryRelayPath` and `buildDeliveryRelayIndex` from `conversation-grounding.ts`.
- Grounding should read final delivery state from task-state `delivery` and replay transition events only.
- Remove `resolveDeliveryRelayPath` if no remaining live caller exists.
- Remove `deliveryRelayEnabled` policy switch if no longer used.

Replay live-path rule:

- Replay logging failure must not block ACK, dispatch, progress, or final delivery.
- For hot paths, use a helper such as `recordPolicyReplayAsync(...)` or `void recordPolicyReplay(...).catch(...)`.
- Tests can await replay helpers directly, but runtime hooks should not depend on replay fs latency.

Tests:

- `rg "replay-logger" extensions/octoclaw-runtime/src -g'*.ts'` returns no source imports.
- `rg "deliveryRelay|DeliveryRelay|resolveDeliveryRelayPath" extensions/octoclaw-runtime/src -g'*.ts'` returns no live source hits.
- Existing replay/grounding tests pass after facts are rewritten around task-state delivery.

## Implementation Order

### P1-A: Delivery Outbox Module

Files:

- Add `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`.
- Add `extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts`.
- Update `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`.
- Update `extensions/octoclaw-runtime/src/extension-entry.ts` to register low-frequency flush.

Acceptance:

- Final result queues when adapter is unavailable.
- Flush sends and removes outbox entry when adapter becomes available.
- Task-state delivery status changes on queue/success/failure.

### P1-B: Status Reads Durable Task State Only

Files:

- Update `extensions/octoclaw-runtime/src/tools/registration.ts`.
- Update dispatch/status tests.

Acceptance:

- `octoclaw_status` does not synthesize tasks from `policyState`.
- Clearing `policyState` does not remove persisted task-state status.
- Dispatch success cannot claim spawn/result evidence without durable task-state record.

### P1-C: ACK/Progress Cleanup

Files:

- Update `extensions/octoclaw-runtime/src/ack/ack-timing.ts`.
- Update `extensions/octoclaw-runtime/src/ack/ack-decision.ts`.
- Update `extensions/octoclaw-runtime/src/ack/ack-guard.ts`.
- Update `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`.
- Update ACK/progress tests.

Acceptance:

- Delegate route has no tier1/2/3 “still running” messages.
- Reply route ACK behavior remains intact.
- `no_valid_thread_anchor` becomes top-level fallback where a session target exists.
- All visible ACK/progress/final messages go through `sendIMMessage`.

### P1-D: Replay Split Finalization

Files:

- Update imports across runtime from `replay/replay-logger.ts` to specific modules.
- Delete `extensions/octoclaw-runtime/src/replay/replay-logger.ts`.
- Update `extensions/octoclaw-runtime/src/index.ts`.
- Update `extensions/octoclaw-runtime/src/conversation-grounding.ts`.
- Remove unused relay path helpers from `extensions/octoclaw-runtime/src/resolve/env.ts`.

Acceptance:

- No `replay-logger.ts` source imports remain.
- No delivery relay symbols remain.
- Grounding uses task-state delivery status, not relay jsonl.

## OpenSpec Work Packet Template

Use this packet when delegating to OpenCode/headless one-shot:

```text
ulw
Task: Implement OctoClaw Phase 1 stabilization slice <P1-A|P1-B|P1-C|P1-D>.

Design references:
- docs/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md Phase 1
- docs/octoclaw-phase1-stabilization-design-2026-04-29.md

Truth rules:
- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff/continuity truth.
- task-state.json is durable projection truth.
- policyState is short-lived hook cache only.
- No raw child transcript injection.
- No remote/dual judge.

Allowed files:
<exact files for slice>

Non-goals:
- Do not touch Phase 2 package consolidation.
- Do not change unrelated judge/classifier/route-hint behavior.
- Do not add new keyword-based dispatch gating.

Acceptance:
<slice-specific acceptance above>

Tests to run:
<slice-specific tests plus pnpm --filter @octoclaw/runtime run check>

Evidence required:
- Changed files.
- Test output summary.
- Confirmation that only allowed files were touched.
- Remaining risks.
Do not commit; Codex will review.
```

## Final Phase 1 Gate

Phase 1 is done only when all checks pass:

```bash
rg "replay-logger" extensions/octoclaw-runtime/src -g'*.ts'
# expected: no source imports/hits except deleted file absent

rg "deliveryRelay|DeliveryRelay|registerPendingDelivery|reconcilePendingDeliveriesForSession|recordDeliveryRelayEvent|resolveDeliveryRelayPath" extensions/octoclaw-runtime/src -g'*.ts'
# expected: no hits

rg "export const ACK_TIMING" extensions/octoclaw-runtime/src/ack/ack-decision.ts
# expected: no hits

pnpm --filter @octoclaw/runtime run check
pnpm exec vitest run \
  extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts \
  extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/ack/ack-decision.test.ts \
  extensions/octoclaw-runtime/src/ack/ack-guard.test.ts \
  extensions/octoclaw-runtime/src/ack/execution-transition-notifier.test.ts \
  extensions/octoclaw-runtime/src/replay/*.test.ts \
  extensions/octoclaw-runtime/src/conversation-grounding.test.ts
pnpm test
pnpm build
```

Manual/runtime acceptance:

1. Dispatch a delegate task.
2. IM shows ACK, dispatch materialized, spawn started, final result.
3. IM does not show delegate tier1/2/3 “还在跑，稍等” messages.
4. Simulate missing thread anchor; progress appears as a top-level message.
5. Restart OpenClaw; `octoclaw_status` still shows the task from `task-state.json`.
6. Simulate adapter unavailable for final result; outbox queues then flushes when adapter returns.
