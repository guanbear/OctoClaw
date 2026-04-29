import { describe, expect, it } from "vitest";
import type { DeliveryReceipt } from "@octoclaw/contracts/deliveries";
import { acknowledgeReceipt, createAckLedger, recordDeliveryReceipt } from "./index.js";

function buildReceipt(id: string, taskId = "task-1"): DeliveryReceipt {
  return {
    schemaVersion: "octoclaw.contracts/v1",
    kind: "artifact",
    createdAt: "2026-04-18T11:00:00.000Z",
    deliveryReceiptId: id,
    deliveryId: `delivery:${id}`,
    requestIdempotencyKey: taskId,
    receivedAt: "2026-04-18T11:00:05.000Z",
    receiver: "slack",
  };
}

describe("ack ledger", () => {
  it("starts empty", () => {
    expect(createAckLedger()).toEqual({
      receipts: {},
      acknowledgements: {},
    });
  });

  it("records delivery receipts", () => {
    const ledger = recordDeliveryReceipt(createAckLedger(), buildReceipt("receipt-1"));

    expect(ledger.receipts["receipt-1"]).toMatchObject({
      deliveryReceiptId: "receipt-1",
      deliveryId: "delivery:receipt-1",
      receiver: "slack",
      kind: "artifact",
      schemaVersion: "octoclaw.contracts/v1",
    });
  });

  it("acknowledges a receipt", () => {
    const ledger = acknowledgeReceipt(
      createAckLedger(),
      {
        ackId: "ack-1",
        deliveryReceiptId: "receipt-1",
        taskId: "task-1",
        acknowledgedBy: "runtime",
      },
      "2026-04-18T11:00:10.000Z",
    );

    expect(ledger.acknowledgements["receipt-1"]).toEqual({
      ackId: "ack-1",
      deliveryReceiptId: "receipt-1",
      taskId: "task-1",
      acknowledgedBy: "runtime",
      acknowledgedAt: "2026-04-18T11:00:10.000Z",
      status: "acknowledged",
    });
  });

  it("tracks multiple receipts and acknowledgements independently", () => {
    const withReceipts = recordDeliveryReceipt(
      recordDeliveryReceipt(createAckLedger(), buildReceipt("receipt-1", "task-1")),
      buildReceipt("receipt-2", "task-2"),
    );
    const acknowledged = acknowledgeReceipt(withReceipts, {
      ackId: "ack-2",
      deliveryReceiptId: "receipt-2",
      taskId: "task-2",
      acknowledgedBy: "operator",
    });

    expect(Object.keys(acknowledged.receipts)).toHaveLength(2);
    expect(acknowledged.receipts["receipt-1"].requestIdempotencyKey).toBe("task-1");
    expect(acknowledged.receipts["receipt-2"].requestIdempotencyKey).toBe("task-2");
    expect(Object.keys(acknowledged.acknowledgements)).toEqual(["receipt-2"]);
  });
});
