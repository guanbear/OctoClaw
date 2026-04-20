import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type {
  RuntimeTaskflowManagedRecord,
  RuntimeTaskflowTaskRecord,
} from "./runtime-taskflow.js";

export type RuntimeStateSurfaceRecord = RuntimeTaskflowManagedRecord | RuntimeTaskflowTaskRecord;

export interface RuntimeStateDetailsSurface {
  taskId: string;
  flowId: string;
  substrateState: string;
  substrateRevision: number;
  syncMode: "managed" | "mirrored";
  runtime: "openclaw-native";
  claimOwner: string;
  workspaceMode: string;
  writeScopeSummary?: string;
  summary: string;
  truth: RuntimeStateSurfaceRecord["truth"];
  projection: RuntimeStateSurfaceRecord["projection"];
}

function substrateSummary(record: RuntimeStateSurfaceRecord): string {
  return `${record.runtime} ${record.syncMode} ${record.substrateState}`.trim();
}

export function buildStatusSurfaceView(record: RuntimeStateSurfaceRecord): StatusSurfaceViewModel {
  const route = (record as RuntimeStateSurfaceRecord & { identity?: { route?: string } }).identity?.route
    || (record.truth.requestId ? "delegate" : "reply");
  const taskClass = String((record.projection as { task_class?: string } | undefined)?.task_class ?? "").trim();
  return {
    ...buildContractEnvelope("projection"),
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    state: record.substrateState,
    route,
    role: taskClass === "control_observer" ? "observer_probe" : route === "reply" ? "main_reply" : "worker_research",
    coordinationMode: route === "delegate" ? "solo_worker" : "",
    backendSummary: "openclaw-native",
    workerPool: "octoclaw-runtime",
    substrateSummary: substrateSummary(record),
    actionAvailability: ["status", "details", "queue", "timeline"],
    queuePosition: 0,
    modelSummary: "unreported",
    costEstimate: "unreported",
    claimOwner: record.ownership.claimOwner,
    leaseState: "active",
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary || "none",
    threadCount: 1,
    advisorUsageSummary: "none",
  };
}

export function buildStateDetailsSurface(record: RuntimeStateSurfaceRecord): RuntimeStateDetailsSurface {
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    substrateState: record.substrateState,
    substrateRevision: record.substrateRevision,
    syncMode: record.syncMode,
    runtime: record.runtime,
    claimOwner: record.ownership.claimOwner,
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary,
    summary: substrateSummary(record),
    truth: record.truth,
    projection: record.projection,
  };
}
