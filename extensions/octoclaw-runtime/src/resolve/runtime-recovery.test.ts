import { describe, expect, it } from "vitest";
import { createDeliveryOutbox } from "./delivery-outbox.js";
import { checkActiveTaskRecovery } from "./runtime-recovery.js";

describe("checkActiveTaskRecovery", () => {
  it("delivers a completed pending result once during startup reconciliation", () => {
    const outbox = createDeliveryOutbox();
    const item = outbox.upsertPendingResult({
      taskId: "task-1",
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:slack:default:direct:user:thread:1",
      requesterOrigin: { channel: "slack", to: "user:U1", accountId: "default", threadId: "1" },
      workContractId: "wc-1",
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      resultText: "完成：Brave key 有效。",
      now: "2026-05-26T05:40:44.000Z",
    });
    const delivered: string[] = [];

    const result = checkActiveTaskRecovery({
      now: new Date("2026-05-26T05:41:00.000Z"),
      outbox,
      deliverResult: (pending) => {
        delivered.push(pending.outboxId);
        return true;
      },
      taskRuns: [{
        task_id: "task-1",
        run_id: "run-1",
        status: "succeeded",
        delivery_status: "pending",
      }],
    });

    expect(result.updatedCount).toBe(1);
    expect(result.recoveries).toEqual([expect.objectContaining({
      action: "deliver_result",
      taskId: "task-1",
      runId: "run-1",
      outboxId: item.outboxId,
    })]);
    expect(delivered).toEqual([item.outboxId]);
    expect(outbox.list()[0].status).toBe("delivered");
  });

  it("reports restart-interrupted runs without synthesizing a successful result", () => {
    const outbox = createDeliveryOutbox();

    const result = checkActiveTaskRecovery({
      now: new Date("2026-05-26T05:41:00.000Z"),
      outbox,
      taskRuns: [{
        task_id: "task-2",
        run_id: "run-2",
        status: "failed",
        delivery_status: "delivered",
        error: "gateway closed (1012): service restart",
      }],
    });

    expect(result.updatedCount).toBe(1);
    expect(result.recoveries).toEqual([expect.objectContaining({
      action: "interrupted_by_restart",
      taskId: "task-2",
      runId: "run-2",
      reason: "gateway_restart",
    })]);
  });

  it("skips outbox rows already delivered or interrupted", () => {
    const outbox = createDeliveryOutbox();
    const delivered = outbox.upsertPendingResult({
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
    outbox.markDelivered(delivered.outboxId, "2026-05-26T05:40:45.000Z");
    const interrupted = outbox.upsertPendingResult({
      taskId: "task-2",
      runId: "run-2",
      childSessionKey: "child",
      requesterSessionKey: "requester",
      requesterOrigin: { channel: "slack" },
      workContractId: "wc-2",
      delegateTaskId: "delegate-2",
      attemptId: "attempt-2",
      resultText: "partial",
      now: "2026-05-26T05:40:44.000Z",
    });
    outbox.markInterrupted(interrupted.outboxId, "gateway_restart", "2026-05-26T05:40:45.000Z");

    const result = checkActiveTaskRecovery({
      outbox,
      taskRuns: [
        { task_id: "task-1", run_id: "run-1", status: "succeeded", delivery_status: "pending" },
        { task_id: "task-2", run_id: "run-2", status: "lost", error: "backing session missing" },
      ],
    });

    expect(result.updatedCount).toBe(0);
    expect(result.recoveries).toEqual([]);
  });
});
