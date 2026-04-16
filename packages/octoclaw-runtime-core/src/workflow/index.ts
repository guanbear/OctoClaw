import type { ScopeMetadata } from "../../../octoclaw-contracts/src/schemas.ts";
import { createAckLedger, type AckLedger } from "../ack/index.ts";
import { createOutbox, type DeliveryOutbox } from "../delivery/outbox.ts";
import { buildRuntimeDeadlines, type DeadlineBudgetInput, type RuntimeDeadlines } from "../tasks/deadlines.ts";
import { canClaim, claimTask, renewClaimLease, type RuntimeClaim } from "../tasks/claims.ts";

export interface RuntimeTaskMaterialization {
  requestId: string;
  taskId: string;
  flowId: string;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  taskPacketRef: string;
}

export interface RuntimeWorkflowState {
  requestId: string;
  taskId: string;
  flowId: string;
  ingressOrchestration: "queued" | "accepted" | "rejected";
  workflowOrchestration: "planned" | "running" | "waiting" | "completed" | "failed";
  reconcileOrRecovery: "idle" | "reconciling" | "recovering";
  deadlines: RuntimeDeadlines;
  claim: RuntimeClaim | null;
  outbox: DeliveryOutbox;
  ackLedger: AckLedger;
  scope: ScopeMetadata;
  taskMaterialization: RuntimeTaskMaterialization;
}

export interface StartWorkflowInput {
  requestId: string;
  taskId: string;
  flowId: string;
  claimOwner: string;
  leaseDurationMs: number;
  deadlineBudget: DeadlineBudgetInput;
  scope: ScopeMetadata;
}

export function startRuntimeWorkflow(input: StartWorkflowInput): RuntimeWorkflowState {
  const claim = claimTask(input.taskId, input.claimOwner, input.leaseDurationMs);
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    ingressOrchestration: "accepted",
    workflowOrchestration: "planned",
    reconcileOrRecovery: "idle",
    deadlines: buildRuntimeDeadlines(input.deadlineBudget),
    claim,
    outbox: createOutbox(),
    ackLedger: createAckLedger(),
    scope: input.scope,
    taskMaterialization: materializeRuntimeTaskPacket(input, claim),
  };
}

export function advanceWorkflowToRunning(state: RuntimeWorkflowState, nextClaimOwner: string): RuntimeWorkflowState {
  const nextClaim = resolveNextClaim(state, nextClaimOwner);
  return {
    ...state,
    workflowOrchestration: "running",
    claim: nextClaim,
    taskMaterialization: refreshTaskMaterialization(state.taskMaterialization, nextClaim),
  };
}

function materializeRuntimeTaskPacket(input: StartWorkflowInput, claim: RuntimeClaim): RuntimeTaskMaterialization {
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    claimOwner: claim.claimOwner,
    claimToken: claim.claimToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    taskPacketRef: `${input.flowId}:${input.taskId}:${claim.claimToken}`,
  };
}

function refreshTaskMaterialization(
  taskMaterialization: RuntimeTaskMaterialization,
  claim: RuntimeClaim,
): RuntimeTaskMaterialization {
  return {
    ...taskMaterialization,
    claimOwner: claim.claimOwner,
    claimToken: claim.claimToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    taskPacketRef: `${taskMaterialization.flowId}:${taskMaterialization.taskId}:${claim.claimToken}`,
  };
}

function resolveNextClaim(state: RuntimeWorkflowState, nextClaimOwner: string): RuntimeClaim {
  if (state.claim && state.claim.claimOwner === nextClaimOwner) {
    return renewClaimLease(state.claim);
  }

  if (!canClaim(state.claim)) {
    throw new Error("claim_owner_conflict");
  }

  return claimTask(state.taskId, nextClaimOwner, state.claim?.leaseDurationMs ?? 30_000);
}

export function markWorkflowForRecovery(state: RuntimeWorkflowState): RuntimeWorkflowState {
  return {
    ...state,
    reconcileOrRecovery: "recovering",
  };
}
