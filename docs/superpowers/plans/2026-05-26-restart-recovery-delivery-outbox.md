# Restart Recovery Delivery Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gateway restart boundaries explicit and recover pending child results or interrupted child status after startup.

**Architecture:** Add a small durable delivery outbox module and a bounded startup reconciler that consumes structured task/run evidence. Keep native TaskFlow as lifecycle truth; do not synthesize successful results without persisted result text.

**Tech Stack:** TypeScript, Vitest, OpenSpec-lite, GitNexus impact checks.

---

## File Structure

- Create `extensions/octoclaw-runtime/src/resolve/delivery-outbox.ts`: in-memory/file-safe primitives for pending child result delivery records.
- Create `extensions/octoclaw-runtime/src/resolve/delivery-outbox.test.ts`: RED/GREEN tests for persistence, delivered marking, and duplicate dedupe.
- Modify `extensions/octoclaw-runtime/src/resolve/runtime-recovery.ts`: implement `checkActiveTaskRecovery()` as a pure bounded reconciler over injected records/outbox state.
- Create `extensions/octoclaw-runtime/src/resolve/runtime-recovery.test.ts`: RED/GREEN tests for pending-result delivery, restart interruption, and idempotency.
- Modify `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`: add restart/recovery transition text only.
- Extend `extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`: cover restart/interrupted transition wording.
- Update `openspec/changes/restart-recovery-delivery-outbox-0.6.x/tasks.md`: record completed impact and verification steps.

## Task 1: Impact And Documentation

- [x] **Step 1: Record impact results**

Update `openspec/changes/restart-recovery-delivery-outbox-0.6.x/tasks.md` Phase B with:

```markdown
- [x] Run `npx gitnexus impact checkActiveTaskRecovery --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Run `npx gitnexus impact emitExecutionTransitionNotification --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Run `npx gitnexus impact applyNativeAnnounceCompletionState --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Report blast radius before editing production symbols.
```

- [x] **Step 2: Verify docs are present**

Run: `test -f openspec/changes/restart-recovery-delivery-outbox-0.6.x/proposal.md && test -f openspec/changes/restart-recovery-delivery-outbox-0.6.x/design.md && test -f openspec/changes/restart-recovery-delivery-outbox-0.6.x/bdd.md && test -f openspec/changes/restart-recovery-delivery-outbox-0.6.x/tasks.md`

Expected: exit 0.

## Task 2: Delivery Outbox

- [x] **Step 1: Write failing tests**

Add `extensions/octoclaw-runtime/src/resolve/delivery-outbox.test.ts` with tests:

```ts
import { describe, expect, it } from "vitest";
import { createDeliveryOutbox, hashResultText } from "./delivery-outbox.js";

describe("delivery outbox", () => {
  it("persists a safe pending child result before delivery", () => {
    const outbox = createDeliveryOutbox();
    const item = outbox.upsertPendingResult({
      taskId: "task-1",
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:slack:default:direct:user:thread:1",
      requesterOrigin: { channel: "slack", to: "user:U1", accountId: "default", threadId: "1" },
      workContractId: "wc-1",
      delegateTaskId: "delegate-1",
      attemptId: "delegate-1:attempt:1",
      resultText: "完成：key 有效。",
      now: "2026-05-26T05:40:44.000Z",
    });

    expect(item.status).toBe("pending");
    expect(item.resultHash).toBe(hashResultText("完成：key 有效。"));
    expect(JSON.stringify(item)).not.toContain("rawTranscript");
  });

  it("marks delivered idempotently by result hash", () => {
    const outbox = createDeliveryOutbox();
    const item = outbox.upsertPendingResult({
      taskId: "task-1",
      runId: "run-1",
      childSessionKey: "child",
      requesterSessionKey: "requester",
      requesterOrigin: { channel: "slack" },
      workContractId: "wc-1",
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      resultText: "result",
      now: "2026-05-26T05:40:44.000Z",
    });

    expect(outbox.markDelivered(item.outboxId, "2026-05-26T05:40:45.000Z").status).toBe("delivered");
    expect(outbox.shouldDeliverResult(item.resultHash)).toBe(false);
  });
});
```

- [x] **Step 2: Run RED**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/resolve/delivery-outbox.test.ts`

Expected: FAIL because `delivery-outbox.js` does not exist.

- [x] **Step 3: Implement minimal module**

Create `delivery-outbox.ts` with `createDeliveryOutbox()`, `hashResultText()`, `upsertPendingResult()`, `markDelivered()`, `shouldDeliverResult()`, and `listPending()`.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/resolve/delivery-outbox.test.ts`

Expected: PASS.

## Task 3: Runtime Recovery Reconciler

- [x] **Step 1: Write failing tests**

Add tests in `extensions/octoclaw-runtime/src/resolve/runtime-recovery.test.ts` proving:

- completed pending result returns a `deliver_result` recovery once;
- restart errors without result return `interrupted_by_restart`;
- repeated reconciliation skips delivered/interrupted outbox rows.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/resolve/runtime-recovery.test.ts`

Expected: FAIL because `checkActiveTaskRecovery()` still returns no recoveries.

- [x] **Step 3: Implement minimal pure reconciliation**

Extend `checkActiveTaskRecovery(options)` to accept injected `taskRuns`, `outbox`, and `deliver` callback. Do not read production sqlite in this first slice.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/resolve/runtime-recovery.test.ts`

Expected: PASS.

## Task 4: Restart Transition Text

- [x] **Step 1: Write failing tests**

Extend `execution-transition-notifier` tests to call `projectTransitionText()` for:

- `restart_draining`
- `restart_recovered`
- `interrupted_by_restart`

- [x] **Step 2: Run RED**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`

Expected: FAIL because the transition kinds are not known.

- [x] **Step 3: Implement text-only transition support**

Update `ExecutionTransitionKind`, text map, and dedupe terminal-key list if needed.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`

Expected: PASS.

## Task 5: Verification

- [x] Run `pnpm vitest run extensions/octoclaw-runtime/src/resolve/delivery-outbox.test.ts extensions/octoclaw-runtime/src/resolve/runtime-recovery.test.ts extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`.
- [x] Run `pnpm --filter @octoclaw/runtime run check`.
- [x] Run `pnpm check` if focused checks pass.
- [x] Run `npx gitnexus detect-changes --repo OctoClaw-detached-conflict-backup-20260512-155353 --scope all`.
- [x] Update OpenSpec task checkboxes.
