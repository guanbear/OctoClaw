import type { DeliveryEnvelope, DeliveryReceipt } from "../../../octoclaw-contracts/src/deliveries";

export interface OutboxEntry {
  outboxId: string;
  deliveryId: string;
  deliveryReceiptId: string;
  taskId: string;
  status: "queued" | "sent" | "acknowledged" | "failed";
  queuedAt: string;
  sentAt?: string;
  receipt?: DeliveryReceipt;
  envelope: DeliveryEnvelope;
}

export interface DeliveryOutbox {
  entries: Record<string, OutboxEntry>;
}

export function createOutbox(): DeliveryOutbox {
  return { entries: {} };
}

export function enqueueDelivery(outbox: DeliveryOutbox, envelope: DeliveryEnvelope): DeliveryOutbox {
  const entry: OutboxEntry = {
    outboxId: envelope.outboxId,
    deliveryId: envelope.deliveryId,
    deliveryReceiptId: envelope.deliveryReceiptId,
    taskId: envelope.taskId,
    status: "queued",
    queuedAt: envelope.queuedAt,
    envelope,
  };

  return {
    entries: {
      ...outbox.entries,
      [entry.outboxId]: entry,
    },
  };
}

export function markDeliverySent(outbox: DeliveryOutbox, outboxId: string, sentAt = new Date().toISOString()): DeliveryOutbox {
  const current = outbox.entries[outboxId];
  if (!current) {
    throw new Error("outbox_entry_missing");
  }
  return {
    entries: {
      ...outbox.entries,
      [outboxId]: {
        ...current,
        status: "sent",
        sentAt,
      },
    },
  };
}

export function attachDeliveryReceipt(outbox: DeliveryOutbox, receipt: DeliveryReceipt): DeliveryOutbox {
  const match = Object.values(outbox.entries).find((entry) => entry.deliveryReceiptId === receipt.deliveryReceiptId);
  if (!match) {
    throw new Error("delivery_receipt_unknown");
  }
  return {
    entries: {
      ...outbox.entries,
      [match.outboxId]: {
        ...match,
        status: "acknowledged",
        receipt,
      },
    },
  };
}
