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

export type TelemetryLane = "reply" | "delegate" | "flow";

export interface MetricSummary {
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface CostSpeedLaneReport {
  lane: TelemetryLane;
  requestCount: number;
  successCount: number;
  ackMs: MetricSummary;
  routeDecisionMs: MetricSummary;
  taskMaterializeMs: MetricSummary;
  queueWaitMs: MetricSummary;
  firstProgressMs: MetricSummary;
  finalDeliveryMs: MetricSummary;
  totalLatencyMs: MetricSummary;
  estimatedCostUsd: number;
  actualCostUsd: number;
  costPerRequest?: number;
  costPerSuccess?: number;
  fallbackCount: number;
  retryCount: number;
  terminalStates: Record<string, number>;
  parentContextTokensAdded: MetricSummary;
  resultPacketTokens: MetricSummary;
}

export interface CostSpeedBaselineReport {
  generatedAt: string;
  lanes: CostSpeedLaneReport[];
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

function percentile(values: number[], percentileValue: number): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function metric(values: Array<number | undefined>): MetricSummary {
  const clean = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    p99: percentile(clean, 99),
  };
}

function laneForTelemetry(item: OptimizationTelemetry): TelemetryLane {
  if (String(item.telemetryId).startsWith("flow:")) return "flow";
  return item.route === "reply" ? "reply" : "delegate";
}

function isSuccess(item: OptimizationTelemetry): boolean {
  return ["success", "succeeded", "completed"].includes(String(item.terminalState ?? "").toLowerCase());
}

export function buildCostSpeedBaselineReport(
  telemetry: OptimizationTelemetry[],
  generatedAt: string | Date = new Date(),
): CostSpeedBaselineReport {
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : generatedAt;
  const lanes: CostSpeedLaneReport[] = [];

  for (const lane of ["reply", "delegate", "flow"] as const) {
    const items = telemetry.filter((item) => laneForTelemetry(item) === lane);
    const successCount = items.filter(isSuccess).length;
    const estimatedCostUsd = items.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
    const actualCostUsd = items.reduce((sum, item) => sum + (item.actualCostUsd ?? 0), 0);
    const terminalStates = items.reduce<Record<string, number>>((acc, item) => {
      const key = String(item.terminalState ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    lanes.push({
      lane,
      requestCount: items.length,
      successCount,
      ackMs: metric(items.map((item) => item.ackMs)),
      routeDecisionMs: metric(items.map((item) => item.routeDecisionMs)),
      taskMaterializeMs: metric(items.map((item) => item.taskMaterializeMs)),
      queueWaitMs: metric(items.map((item) => item.queueWaitMs)),
      firstProgressMs: metric(items.map((item) => item.firstProgressMs)),
      finalDeliveryMs: metric(items.map((item) => item.finalDeliveryMs)),
      totalLatencyMs: metric(items.map((item) => item.totalLatencyMs)),
      estimatedCostUsd,
      actualCostUsd,
      costPerRequest: items.length > 0 ? actualCostUsd / items.length : undefined,
      costPerSuccess: successCount > 0 ? actualCostUsd / successCount : undefined,
      fallbackCount: items.reduce((sum, item) => sum + (item.fallbackCount ?? 0), 0),
      retryCount: items.reduce((sum, item) => sum + (item.retryCount ?? 0), 0),
      terminalStates,
      parentContextTokensAdded: metric(items.map((item) => item.parentContextTokensAdded)),
      resultPacketTokens: metric(items.map((item) => item.resultPacketTokens)),
    });
  }

  return { generatedAt: generatedAtIso, lanes };
}
