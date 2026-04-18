import {
  type OptimizationTelemetry,
  type PolicyTelemetry,
} from "@octoclaw/contracts/telemetry";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type { NormalizedRuntimeRequest } from "../requests/index.js";
import type { RuntimeTaskInterfaceState } from "../tasks/index.js";
import type { RuntimeWorkflowState } from "../workflow/index.js";

export interface RuntimeTelemetryBundle {
  request: PolicyTelemetry;
  task: OptimizationTelemetry;
  flow: OptimizationTelemetry;
}

function telemetryId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((part) => String(part || "").trim()).filter(Boolean)].join(":");
}

export function emitRequestTelemetry(
  request: NormalizedRuntimeRequest,
  workflow: RuntimeWorkflowState,
): PolicyTelemetry {
  return {
    ...buildContractEnvelope("telemetry"),
    telemetryId: telemetryId("policy", request.requestId),
    requestId: request.requestId,
    selectedRoute: workflow.identity.route,
    selectedRole: workflow.execution.role,
    backend: workflow.execution.backend,
    modelProfile: workflow.execution.modelProfile,
    reasonCodes: [
      workflow.execution.admission.reason,
      workflow.ingressOrchestration,
      workflow.workflowOrchestration,
    ].filter(Boolean),
    ...request.scope,
  };
}

function emitOptimizationTelemetry(
  kind: "task" | "flow",
  request: NormalizedRuntimeRequest,
  workflow: RuntimeWorkflowState,
  taskState: RuntimeTaskInterfaceState,
): OptimizationTelemetry {
  const queueBudget = workflow.execution.admission.queueBudget;
  const concurrencyBudget = workflow.execution.admission.maxWorkers ?? 0;
  const capabilityBudget = [workflow.identity.route, workflow.identity.materializationIntent];

  return {
    ...buildContractEnvelope("telemetry"),
    telemetryId: telemetryId(kind, workflow.identity.flowId, kind === "task" ? workflow.identity.taskId : "summary"),
    requestId: workflow.identity.requestId,
    taskId: workflow.identity.taskId,
    flowId: workflow.identity.flowId,
    route: workflow.identity.route,
    role: workflow.execution.role,
    coordinationMode: workflow.execution.coordinationMode || "solo_worker",
    queueBudget,
    concurrencyBudget,
    capabilityBudget,
    modelId: workflow.execution.modelProfile,
    routeLatencyMs: workflow.execution.admission.latencyTarget === "interactive" ? 250 : 1000,
    modelProfile: workflow.execution.modelProfile,
    backend: workflow.execution.backend,
    queueDeadlineAt: taskState.deadlines.queueDeadline,
    startDeadlineAt: taskState.deadlines.startDeadline,
    progressDeadlineAt: taskState.deadlines.progressDeadline,
    runtimeDeadlineAt: taskState.deadlines.runtimeDeadline,
    deliveryDeadlineAt: taskState.deadlines.deliveryDeadline,
    ...request.scope,
  };
}

export function emitRuntimeTelemetry(
  request: NormalizedRuntimeRequest,
  workflow: RuntimeWorkflowState,
  taskState: RuntimeTaskInterfaceState,
): RuntimeTelemetryBundle {
  return {
    request: emitRequestTelemetry(request, workflow),
    task: emitOptimizationTelemetry("task", request, workflow, taskState),
    flow: emitOptimizationTelemetry("flow", request, workflow, taskState),
  };
}
