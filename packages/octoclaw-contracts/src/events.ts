import type { ContractEnvelope, IdempotencyMetadata, ScopeMetadata } from "./schemas.js";

export interface OwnershipMetadata {
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  resumeGeneration: number;
}

export interface TaskIdentity {
  taskId: string;
  flowId: string;
  parentTaskId?: string;
}

export interface TaskEvent extends ContractEnvelope, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  eventType: string;
  eventAt: string;
  detail?: string;
}

export interface FlowEvent extends ContractEnvelope, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata {
  flowId: string;
  eventType: string;
  eventAt: string;
  activeTaskIds: string[];
}

export function isOwnershipMetadata(value: Partial<OwnershipMetadata>): value is OwnershipMetadata {
  return typeof value.claimOwner === "string"
    && typeof value.claimToken === "string"
    && typeof value.leaseExpiresAt === "string"
    && typeof value.lastHeartbeatAt === "string"
    && typeof value.resumeGeneration === "number";
}
