import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeliveryOutbox, createFileDeliveryOutbox, hashResultText } from "./delivery-outbox.js";

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

  it("reloads pending child results from disk after restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-delivery-outbox-"));
    const pathname = path.join(dir, "delivery-outbox.json");
    const outbox = createFileDeliveryOutbox(pathname);
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

    const reloaded = createFileDeliveryOutbox(pathname);

    expect(reloaded.listPending()).toEqual([item]);
  });
});
