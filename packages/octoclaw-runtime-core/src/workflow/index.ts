import type { ScopeMetadata } from "../../../octoclaw-contracts/src/schemas";
import { createAckLedger, type AckLedger } from "../ack";
import { createOutbox, type DeliveryOutbox } from "../delivery/outbox";
import { buildRuntimeDeadlines, type DeadlineBudgetInput, type RuntimeDeadlines } from "../tasks/deadlines";
import { canClaim, claimTask, type RuntimeClaim } from "../tasks/claims";

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
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    ingressOrchestration: "accepted",
    workflowOrchestration: "planned",
    reconcileOrRecovery: "idle",
    deadlines: buildRuntimeDeadlines(input.deadlineBudget),
    claim: claimTask(input.taskId, input.claimOwner, input.leaseDurationMs),
    outbox: createOutbox(),
    ackLedger: createAckLedger(),
    scope: input.scope,
  };
}

export function advanceWorkflowToRunning(state: RuntimeWorkflowState, nextClaimOwner: string): RuntimeWorkflowState {
  if (!canClaim(state.claim)) {
    throw new Error("claim_owner_conflict");
  }
  return {
    ...state,
    workflowOrchestration: "running",
    claim: claimTask(state.taskId, nextClaimOwner, state.claim?.leaseDurationMs ?? 30_000),
  };
}

export function markWorkflowForRecovery(state: RuntimeWorkflowState): RuntimeWorkflowState {
  return {
    ...state,
    reconcileOrRecovery: "recovering",
  };
}
