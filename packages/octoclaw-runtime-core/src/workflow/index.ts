import type {
  DeliveryState,
  ExecutionBackend,
  ExecutionIdentity,
  ExecutionProvenance,
  LifecyclePhase,
  LifecycleState,
  ScopeMetadata,
} from "../../../octoclaw-contracts/src/schemas.ts";
import type { NormalizedRuntimeRequest } from "../requests/index.ts";
import { createAckLedger, type AckLedger } from "../ack/index.ts";
import { createOutbox, type DeliveryOutbox } from "../delivery/outbox.ts";
import {
  buildFinalDelivery,
  buildProgressDelivery,
  enqueueStructuredDelivery,
  type RuntimeDeliveryInput,
  type RuntimeStructuredDelivery,
} from "../delivery/protocol.ts";
import { emitRuntimeTelemetry, type RuntimeTelemetryBundle } from "../telemetry/index.ts";
import {
  buildRuntimeTaskInterface,
  renewTaskInterfaceHeartbeat,
  resolveTaskClaimOwner,
  type DeadlineBudgetInput,
  type RuntimeClaim,
  type RuntimeDeadlines,
  type RuntimeTaskInterfaceState,
  type RuntimeTaskMaterializationPacket,
} from "../tasks/index.ts";
import type { PolicyDecision } from "../../../octoclaw-policy/src/judge/index.ts";

export type RuntimeTaskMaterialization = RuntimeTaskMaterializationPacket;

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
  const identity = deriveExecutionIdentity(input.decision, input);
  const taskInterface = buildRuntimeTaskInterface({
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    requestIdempotencyKey: input.requestId,
    taskIdempotencyKey: input.taskId,
    flowIdempotencyKey: input.flowId,
    claimOwner: input.claimOwner,
    leaseDurationMs: input.leaseDurationMs,
    identity,
    deadlineBudget: input.deadlineBudget,
  });
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
    deadlines: taskInterface.deadlines,
    claim: taskInterface.claim,
    outbox: createOutbox(),
    ackLedger: createAckLedger(),
    scope: input.scope,
    taskMaterialization: taskInterface.materialization,
  };
}

export function advanceWorkflowToRunning(state: RuntimeWorkflowState, nextClaimOwner: string): RuntimeWorkflowState {
  const nextTaskState = resolveTaskClaimOwner(runtimeTaskStateFromWorkflow(state), nextClaimOwner);
  return {
    ...state,
    workflowOrchestration: "running",
    lifecycle: {
      ...state.lifecycle,
      phase: "running",
      startedAt: state.lifecycle.startedAt || new Date().toISOString(),
    },
    claim: nextTaskState.claim,
    taskMaterialization: nextTaskState.materialization,
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

export function markWorkflowTimedOut(
  state: RuntimeWorkflowState,
  failedAt = new Date().toISOString(),
  checkpointAt = failedAt,
): RuntimeWorkflowState {
  return {
    ...markWorkflowCheckpointEmitted(state, checkpointAt),
    workflowOrchestration: "failed",
    lifecycle: {
      ...state.lifecycle,
      phase: "failed",
      checkpointState: "emitted",
      lastCheckpointAt: checkpointAt,
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

  const nextTaskState = renewTaskInterfaceHeartbeat(runtimeTaskStateFromWorkflow(state), {
    claimToken: state.claim.claimToken,
    heartbeatAt,
  });

  return {
    ...state,
    claim: nextTaskState.claim,
    taskMaterialization: nextTaskState.materialization,
  };
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

function runtimeTaskStateFromWorkflow(state: RuntimeWorkflowState): RuntimeTaskInterfaceState {
  if (!state.claim) {
    throw new Error("missing_claim");
  }

  return {
    claim: state.claim,
    deadlines: state.deadlines,
    materialization: state.taskMaterialization,
  };
}

export function buildWorkflowProgressDelivery(
  state: RuntimeWorkflowState,
  input: RuntimeDeliveryInput,
): RuntimeStructuredDelivery {
  return buildProgressDelivery(state, input);
}

export function buildWorkflowFinalDelivery(
  state: RuntimeWorkflowState,
  input: RuntimeDeliveryInput,
): RuntimeStructuredDelivery {
  return buildFinalDelivery(state, input);
}

export function enqueueWorkflowDelivery(
  state: RuntimeWorkflowState,
  delivery: RuntimeStructuredDelivery,
): RuntimeWorkflowState {
  return {
    ...state,
    outbox: enqueueStructuredDelivery(state.outbox, delivery),
  };
}

export function emitWorkflowTelemetry(
  request: NormalizedRuntimeRequest,
  state: RuntimeWorkflowState,
): RuntimeTelemetryBundle {
  return emitRuntimeTelemetry(request, state, runtimeTaskStateFromWorkflow(state));
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
    backend: resolveExecutionBackend(decision.backend),
    materializationIntent: decision.route === "reply"
      ? "reply_inline"
      : decision.route === "observe"
        ? "observe_probe"
        : "spawn_single",
  };
}

function resolveExecutionBackend(backend: PolicyDecision["backend"]): ExecutionBackend {
  switch (backend) {
    case "main":
    case "observer":
    case "worker":
      return "openclaw-native";
    default:
      return backend;
  }
}

function createLifecycleState(phase: LifecyclePhase, deliveryState: DeliveryState): LifecycleState {
  return {
    phase,
    deliveryState,
    checkpointState: "none",
  };
}
