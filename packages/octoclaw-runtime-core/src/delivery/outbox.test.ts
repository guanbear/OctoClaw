import { describe, expect, it } from "vitest";
import type { DeliveryEnvelope, DeliveryReceipt } from "@octoclaw/contracts/deliveries";
import { attachDeliveryReceipt, createOutbox, enqueueDelivery, markDeliverySent } from "./outbox.js";

function buildEnvelope(): DeliveryEnvelope {
  return {
    schemaVersion: "octoclaw.contracts/v1",
    kind: "artifact",
    createdAt: "2026-04-18T17:00:00.000Z",
    requestIdempotencyKey: "req-1",
    taskIdempotencyKey: "task-1",
    flowIdempotencyKey: "flow-1",
    claimOwner: "worker-a",
    claimToken: "token-1",
    leaseExpiresAt: "2026-04-18T17:00:30.000Z",
    lastHeartbeatAt: "2026-04-18T17:00:00.000Z",
    resumeGeneration: 1,
    workspaceMode: "isolated_worktree",
    readScope: [],
    writeScope: [],
    writeScopeSummary: "",
    taskId: "task-1",
    flowId: "flow-1",
    deliveryId: "delivery-1",
    deliveryReceiptId: "receipt-1",
    outboxId: "outbox-1",
    status: "queued",
    channel: "direct",
    queuedAt: "2026-04-18T17:00:00.000Z",
  };
}

function buildReceipt(): DeliveryReceipt {
  return {
    schemaVersion: "octoclaw.contracts/v1",
    kind: "artifact",
    createdAt: "2026-04-18T17:00:10.000Z",
    deliveryReceiptId: "receipt-1",
    deliveryId: "delivery-1",
    requestIdempotencyKey: "req-1",
    receivedAt: "2026-04-18T17:00:10.000Z",
    receiver: "slack",
  };
}

describe("delivery outbox", () => {
  it("starts empty", () => {
    expect(createOutbox()).toEqual({ entries: {} });
  });

  it("enqueues deliveries with queued status", () => {
    const outbox = enqueueDelivery(createOutbox(), buildEnvelope());

    expect(outbox.entries["outbox-1"]).toMatchObject({
      outboxId: "outbox-1",
      deliveryId: "delivery-1",
      deliveryReceiptId: "receipt-1",
      taskId: "task-1",
      status: "queued",
    });
  });

  it("marks queued deliveries as sent", () => {
    const sent = markDeliverySent(
      enqueueDelivery(createOutbox(), buildEnvelope()),
      "outbox-1",
      "2026-04-18T17:00:05.000Z",
    );

    expect(sent.entries["outbox-1"].status).toBe("sent");
    expect(sent.entries["outbox-1"].sentAt).toBe("2026-04-18T17:00:05.000Z");
  });

  it("attaches receipts and marks delivery acknowledged", () => {
    const acknowledged = attachDeliveryReceipt(
      enqueueDelivery(createOutbox(), buildEnvelope()),
      buildReceipt(),
    );

    expect(acknowledged.entries["outbox-1"].status).toBe("acknowledged");
    expect(acknowledged.entries["outbox-1"].receipt?.receiver).toBe("slack");
  });

  it("throws for unknown outbox ids and receipts", () => {
    expect(() => markDeliverySent(createOutbox(), "missing-outbox")).toThrow("outbox_entry_missing");
    expect(() => attachDeliveryReceipt(createOutbox(), buildReceipt())).toThrow("delivery_receipt_unknown");
  });
});
