import type { DeliveryReceipt } from "@octoclaw/contracts/deliveries";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";

export interface AckRecord {
  ackId: string;
  deliveryReceiptId: string;
  taskId: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
  status: "pending" | "acknowledged" | "expired";
}

export interface AckLedger {
  receipts: Record<string, DeliveryReceipt>;
  acknowledgements: Record<string, AckRecord>;
}

export function createAckLedger(): AckLedger {
  return {
    receipts: {},
    acknowledgements: {},
  };
}

export function recordDeliveryReceipt(ledger: AckLedger, receipt: DeliveryReceipt): AckLedger {
  return {
    ...ledger,
    receipts: {
      ...ledger.receipts,
      [receipt.deliveryReceiptId]: {
        ...buildContractEnvelope("projection"),
        ...receipt,
      },
    },
  };
}

export function acknowledgeReceipt(
  ledger: AckLedger,
  input: Pick<AckRecord, "ackId" | "deliveryReceiptId" | "taskId" | "acknowledgedBy">,
  acknowledgedAt = new Date().toISOString(),
): AckLedger {
  return {
    ...ledger,
    acknowledgements: {
      ...ledger.acknowledgements,
      [input.deliveryReceiptId]: {
        ...input,
        acknowledgedAt,
        status: "acknowledged",
      },
    },
  };
}
