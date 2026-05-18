import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";

interface RuntimeStateSurfaceEnvelope {
  taskId: string;
  flowId: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface RuntimeStateSurfaceRecord {
  [key: string]: unknown;
  taskId?: string;
  flowId?: string;
  runtime: "openclaw-native";
  syncMode: "managed";
  substrateState: string;
  substrateRevision: number;
  ownership: {
    claimOwner: string;
    claimToken?: string;
    controllerId?: string;
  };
  scope: {
    workspaceMode: string;
    readScope?: unknown[];
    writeScope?: unknown[];
    writeScopeSummary?: string;
  };
  truth: RuntimeStateSurfaceEnvelope;
  projection: RuntimeStateSurfaceEnvelope & {
    role?: string;
    task_class?: string;
  };
  identity?: {
    route?: string;
    role?: string;
  };
  execution?: {
    role?: string;
  };
}

export interface RuntimeStateDetailsSurface {
  taskId: string;
  flowId: string;
  substrateState: string;
  substrateRevision: number;
  syncMode: "managed";
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
  const route = record.identity?.route || (record.truth.requestId ? "delegate" : "reply");
  const taskClass = String(record.projection.task_class ?? "").trim();
  const role = record.identity?.role
    || record.execution?.role
    || String(record.projection.role ?? "").trim()
    || (taskClass === "control_observer" ? "observer_probe" : route === "reply" ? "main_reply" : "worker_research");
  return {
    ...buildContractEnvelope("projection"),
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    state: record.substrateState,
    route,
    role,
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
