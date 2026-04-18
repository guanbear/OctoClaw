import type { DeliveryEnvelope } from "@octoclaw/contracts/deliveries";
import { buildContractEnvelope, type ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { RuntimeWorkflowState } from "../workflow/index.js";
import { enqueueDelivery, type DeliveryOutbox } from "./outbox.js";

export type RuntimeDeliveryProtocolKind = "progress" | "final";

export interface RuntimeDeliveryProtocolPayload {
  protocolVersion: "octoclaw.runtime_delivery/v1";
  kind: RuntimeDeliveryProtocolKind;
  summary: string;
  detail?: string;
  artifactRefs: string[];
  checkpointState: RuntimeWorkflowState["checkpoints"]["checkpointState"];
  deliverableReady: boolean;
  workflowPhase: RuntimeWorkflowState["lifecycle"]["phase"];
}

export interface RuntimeStructuredDelivery {
  envelope: DeliveryEnvelope;
  payload: RuntimeDeliveryProtocolPayload;
}

export interface RuntimeDeliveryInput {
  channel: string;
  summary: string;
  detail?: string;
  artifactRefs?: string[];
  deliveryKey?: string;
  queuedAt?: string;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeScope(scope: ScopeMetadata): ScopeMetadata {
  return {
    workspaceMode: scope.workspaceMode,
    readScope: Array.isArray(scope.readScope) ? scope.readScope : [],
    writeScope: Array.isArray(scope.writeScope) ? scope.writeScope : [],
    writeScopeSummary: normalizeText(scope.writeScopeSummary),
  };
}

function baseDeliveryEnvelope(
  workflow: RuntimeWorkflowState,
  kind: RuntimeDeliveryProtocolKind,
  input: RuntimeDeliveryInput,
): DeliveryEnvelope {
  const deliveryKey = normalizeText(input.deliveryKey)
    || (kind === "progress"
      ? `${workflow.identity.flowId}:${workflow.identity.taskId}:checkpoint:${workflow.checkpoints.lastCheckpointAt || "pending"}`
      : `${workflow.identity.flowId}:${workflow.identity.taskId}:final`);
  const queuedAt = input.queuedAt || new Date().toISOString();
  const claimOwner = workflow.claim?.claimOwner || workflow.taskMaterialization.claimOwner;
  const claimToken = workflow.claim?.claimToken || workflow.taskMaterialization.claimToken;
  const leaseExpiresAt = workflow.claim?.leaseExpiresAt || workflow.taskMaterialization.leaseExpiresAt;
  const scope = normalizeScope(workflow.scope);

  return {
    ...buildContractEnvelope("artifact", queuedAt),
    requestIdempotencyKey: workflow.identity.requestId,
    taskIdempotencyKey: workflow.identity.taskId,
    flowIdempotencyKey: workflow.identity.flowId,
    claimOwner,
    claimToken,
    leaseExpiresAt,
    lastHeartbeatAt: workflow.claim?.lastHeartbeatAt || queuedAt,
    ...scope,
    taskId: workflow.identity.taskId,
    flowId: workflow.identity.flowId,
    deliveryId: `delivery:${deliveryKey}`,
    deliveryReceiptId: `receipt:${deliveryKey}`,
    outboxId: `outbox:${deliveryKey}`,
    status: "queued",
    channel: normalizeText(input.channel) || "direct",
    queuedAt,
  };
}

function buildPayload(
  workflow: RuntimeWorkflowState,
  kind: RuntimeDeliveryProtocolKind,
  input: RuntimeDeliveryInput,
): RuntimeDeliveryProtocolPayload {
  return {
    protocolVersion: "octoclaw.runtime_delivery/v1",
    kind,
    summary: normalizeText(input.summary),
    detail: normalizeText(input.detail) || undefined,
    artifactRefs: Array.isArray(input.artifactRefs) ? input.artifactRefs.filter(Boolean) : [],
    checkpointState: workflow.checkpoints.checkpointState,
    deliverableReady: workflow.checkpoints.deliverableReady,
    workflowPhase: workflow.lifecycle.phase,
  };
}

export function buildProgressDelivery(
  workflow: RuntimeWorkflowState,
  input: RuntimeDeliveryInput,
): RuntimeStructuredDelivery {
  return {
    envelope: baseDeliveryEnvelope(workflow, "progress", input),
    payload: buildPayload(workflow, "progress", input),
  };
}

export function buildFinalDelivery(
  workflow: RuntimeWorkflowState,
  input: RuntimeDeliveryInput,
): RuntimeStructuredDelivery {
  return {
    envelope: baseDeliveryEnvelope(workflow, "final", input),
    payload: buildPayload(workflow, "final", input),
  };
}

export function enqueueStructuredDelivery(
  outbox: DeliveryOutbox,
  delivery: RuntimeStructuredDelivery,
): DeliveryOutbox {
  return enqueueDelivery(outbox, delivery.envelope);
}
