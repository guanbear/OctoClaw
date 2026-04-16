import type { ContractEnvelope, IdempotencyMetadata, ScopeMetadata } from "./schemas";
import type { OwnershipMetadata, TaskIdentity } from "./events";

export type DeliveryStatus = "queued" | "sent" | "acknowledged" | "failed";

export interface DeliveryEnvelope extends ContractEnvelope, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  deliveryId: string;
  deliveryReceiptId: string;
  outboxId: string;
  status: DeliveryStatus;
  channel: string;
  queuedAt: string;
  sentAt?: string;
}

export interface DeliveryReceipt extends ContractEnvelope {
  deliveryReceiptId: string;
  deliveryId: string;
  requestIdempotencyKey: string;
  receivedAt: string;
  receiver: string;
}

export function isDeliveryReceipt(value: Partial<DeliveryReceipt>): value is DeliveryReceipt {
  return typeof value.deliveryReceiptId === "string"
    && typeof value.deliveryId === "string"
    && typeof value.requestIdempotencyKey === "string"
    && typeof value.receivedAt === "string";
}
