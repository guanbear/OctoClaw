import type {
  DeliveryState,
  ExecutionAuthority,
  ExecutionBackend,
  ExecutionIdentity,
  ExecutionProvenance,
  LifecyclePhase,
  LifecycleState,
  MaterializationIntent,
  ScopeMetadata,
} from "../../../octoclaw-contracts/src/schemas.ts";
import { createAckLedger, type AckLedger } from "../ack/index.ts";
import { createOutbox, type DeliveryOutbox } from "../delivery/outbox.ts";
import { buildRuntimeDeadlines, type DeadlineBudgetInput, type RuntimeDeadlines } from "../tasks/deadlines.ts";
import { canClaim, claimTask, renewClaimLease, type RuntimeClaim } from "../tasks/claims.ts";
import { applyHeartbeat } from "../tasks/claims.ts";
import type { PolicyDecision } from "../../../octoclaw-policy/src/judge/index.ts";

export interface RuntimeTaskMaterialization {
  requestId: string;
  taskId: string;
  flowId: string;
  route: ExecutionIdentity["route"];
  authority: ExecutionAuthority;
  backend: ExecutionBackend;
  materializationIntent: MaterializationIntent;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  taskPacketRef: string;
}

export interface RuntimeLifecycleCheckpoint {
  checkpointState: LifecycleState["checkpointState"];
  lastCheckpointAt: string | null;
  deliverableReady: boolean;
}

export interface RuntimeExecutionRecord extends ExecutionIdentity, ExecutionProvenance {
  role: string;
  modelProfile: string;
  decisionRef: string;
  admission: PolicyDecision["admission"];
}

export interface RuntimeWorkflowState {
  identity: ExecutionIdentity;
  execution: RuntimeExecutionRecord;
  ingressOrchestration: "queued" | "accepted" | "rejected";
  workflowOrchestration: "planned" | "running" | "waiting" | "completed" | "failed";
  reconcileOrRecovery: "idle" | "reconciling" | "recovering";
  lifecycle: LifecycleState;
  checkpoints: RuntimeLifecycleCheckpoint;
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
  decision: PolicyDecision;
  role: string;
  decisionRef?: string;
  provenanceSource?: ExecutionProvenance["source"];
  claimOwner: string;
  leaseDurationMs: number;
  deadlineBudget: DeadlineBudgetInput;
  scope: ScopeMetadata;
}

export function startRuntimeWorkflow(input: StartWorkflowInput): RuntimeWorkflowState {
  const claim = claimTask(input.taskId, input.claimOwner, input.leaseDurationMs);
  const identity = deriveExecutionIdentity(input.decision, input);
  return {
    identity,
    execution: {
      ...identity,
      source: input.provenanceSource || "runtime_orchestrator",
      sourceRef: input.decisionRef || `${input.requestId}:${input.taskId}`,
      materializedBy: "packages/octoclaw-runtime-core/src/workflow/index.ts",
      role: input.role,
      modelProfile: input.decision.modelProfile,
      decisionRef: input.decisionRef || `${input.requestId}:${input.taskId}`,
      admission: input.decision.admission,
    },
    ingressOrchestration: "accepted",
    workflowOrchestration: "planned",
    reconcileOrRecovery: "idle",
    lifecycle: createLifecycleState("materialization_pending", "not_started"),
    checkpoints: {
      checkpointState: "none",
      lastCheckpointAt: null,
      deliverableReady: false,
    },
    deadlines: buildRuntimeDeadlines(input.deadlineBudget),
    claim,
    outbox: createOutbox(),
    ackLedger: createAckLedger(),
    scope: input.scope,
    taskMaterialization: materializeRuntimeTaskPacket(input, claim, identity),
  };
}

export function advanceWorkflowToRunning(state: RuntimeWorkflowState, nextClaimOwner: string): RuntimeWorkflowState {
  const nextClaim = resolveNextClaim(state, nextClaimOwner);
  return {
    ...state,
    workflowOrchestration: "running",
    lifecycle: {
      ...state.lifecycle,
      phase: "running",
      startedAt: state.lifecycle.startedAt || new Date().toISOString(),
    },
    claim: nextClaim,
    taskMaterialization: refreshTaskMaterialization(state.taskMaterialization, nextClaim),
  };
}

export function markWorkflowCheckpointEmitted(state: RuntimeWorkflowState, checkpointAt = new Date().toISOString()): RuntimeWorkflowState {
  return {
    ...state,
    checkpoints: {
      checkpointState: "emitted",
      lastCheckpointAt: checkpointAt,
      deliverableReady: state.checkpoints.deliverableReady,
    },
    lifecycle: {
      ...state.lifecycle,
      phase: "checkpoint_pending",
      checkpointState: "emitted",
      lastCheckpointAt: checkpointAt,
    },
  };
}

export function markWorkflowDeliverableReady(state: RuntimeWorkflowState): RuntimeWorkflowState {
  return {
    ...state,
    checkpoints: {
      ...state.checkpoints,
      deliverableReady: true,
    },
    lifecycle: {
      ...state.lifecycle,
      phase: "deliverable_ready",
      deliveryState: "queued",
    },
  };
}

export function markWorkflowCompleted(state: RuntimeWorkflowState, completedAt = new Date().toISOString()): RuntimeWorkflowState {
  return {
    ...state,
    workflowOrchestration: "completed",
    lifecycle: {
      ...state.lifecycle,
      phase: "completed",
      deliveryState: state.lifecycle.deliveryState === "not_started" ? "queued" : state.lifecycle.deliveryState,
      completedAt,
    },
  };
}

export function markWorkflowFailed(state: RuntimeWorkflowState, failedAt = new Date().toISOString()): RuntimeWorkflowState {
  return {
    ...state,
    workflowOrchestration: "failed",
    lifecycle: {
      ...state.lifecycle,
      phase: "failed",
      failedAt,
    },
  };
}

export function renewWorkflowHeartbeat(
  state: RuntimeWorkflowState,
  heartbeatAt = new Date().toISOString(),
): RuntimeWorkflowState {
  if (!state.claim) {
    throw new Error("missing_claim");
  }

  const nextClaim = applyHeartbeat(state.claim, {
    claimToken: state.claim.claimToken,
    heartbeatAt,
  });

  return {
    ...state,
    claim: nextClaim,
    taskMaterialization: refreshTaskMaterialization(state.taskMaterialization, nextClaim),
  };
}

function materializeRuntimeTaskPacket(
  input: StartWorkflowInput,
  claim: RuntimeClaim,
  identity: ExecutionIdentity,
): RuntimeTaskMaterialization {
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    route: identity.route,
    authority: identity.authority,
    backend: identity.backend,
    materializationIntent: identity.materializationIntent,
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

  return claimTask(state.identity.taskId, nextClaimOwner, state.claim?.leaseDurationMs ?? 30_000);
}

export function markWorkflowForRecovery(state: RuntimeWorkflowState): RuntimeWorkflowState {
  return {
    ...state,
    reconcileOrRecovery: "recovering",
    lifecycle: {
      ...state.lifecycle,
      phase: "recovering",
    },
  };
}

function deriveExecutionIdentity(decision: PolicyDecision, input: StartWorkflowInput): ExecutionIdentity {
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    route: decision.route,
    authority: decision.route === "reply"
      ? "main_session"
      : decision.route === "observe"
        ? "native_runner"
        : "runtime_orchestrator",
    backend: decision.backend,
    materializationIntent: decision.route === "reply"
      ? "reply_inline"
      : decision.route === "observe"
        ? "observe_probe"
        : "spawn_single",
  };
}

function createLifecycleState(phase: LifecyclePhase, deliveryState: DeliveryState): LifecycleState {
  return {
    phase,
    deliveryState,
    checkpointState: "none",
  };
}
