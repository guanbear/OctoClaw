import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import type { RuntimeStateDetailsSurface } from "@octoclaw/runtime/state-surface";

export interface StatusSurfaceProjectionInput {
  record: RuntimeStateSurfaceRecord;
  queuePosition?: number;
  workerPool?: string;
  route?: string;
  actionAvailability?: string[];
  modelSummary?: string;
  costEstimate?: string;
  leaseState?: string;
  isStale?: boolean;
  conflictQueued?: boolean;
}

export interface QueueSurfaceProjection {
  taskId: string;
  flowId: string;
  queuePosition?: number;
  workerPool: string;
  substrateSummary: string;
  claimOwner: string;
  leaseState?: string;
  isStale: boolean;
  conflictQueued: boolean;
}

export interface DetailsSurfaceProjection extends RuntimeStateDetailsSurface {
  leaseState?: string;
  modelSummary?: string;
  costEstimate?: string;
  queuePosition?: number;
  isStale: boolean;
  conflictQueued: boolean;
  actionAvailability: string[];
}

function substrateSummary(record: RuntimeStateSurfaceRecord): string {
  return `${record.runtime} ${record.syncMode} ${record.substrateState}`.trim();
}

function defaultRoute(record: RuntimeStateSurfaceRecord): string {
  return typeof record.truth.requestId === "string" && record.truth.requestId ? "delegate.single" : "reply";
}

function defaultWorkerPool(record: RuntimeStateSurfaceRecord): string {
  if (record.runtime === "openclaw-native") {
    return record.syncMode === "managed" ? "octoclaw-worker" : "octoclaw-runtime";
  }
  return "octoclaw-runtime";
}

function defaultActionAvailability(record: RuntimeStateSurfaceRecord): string[] {
  return record.substrateState === "planned"
    ? ["status", "details", "queue", "timeline"]
    : ["status", "details", "queue", "timeline"];
}

export function buildStatusProjection(input: StatusSurfaceProjectionInput): StatusSurfaceViewModel {
  const { record } = input;
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    state: record.substrateState,
    route: input.route || defaultRoute(record),
    workerPool: input.workerPool || defaultWorkerPool(record),
    substrateSummary: substrateSummary(record),
    actionAvailability: input.actionAvailability || defaultActionAvailability(record),
    queuePosition: input.queuePosition,
    modelSummary: input.modelSummary,
    costEstimate: input.costEstimate,
    claimOwner: record.ownership.claimOwner,
    leaseState: input.leaseState,
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary,
  } as StatusSurfaceViewModel;
}

export function buildQueueProjection(input: StatusSurfaceProjectionInput): QueueSurfaceProjection {
  const { record } = input;
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    queuePosition: input.queuePosition,
    workerPool: input.workerPool || defaultWorkerPool(record),
    substrateSummary: substrateSummary(record),
    claimOwner: record.ownership.claimOwner,
    leaseState: input.leaseState,
    isStale: Boolean(input.isStale),
    conflictQueued: Boolean(input.conflictQueued),
  };
}

export function buildDetailsProjection(input: StatusSurfaceProjectionInput): DetailsSurfaceProjection {
  const { record } = input;
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
    leaseState: input.leaseState,
    modelSummary: input.modelSummary,
    costEstimate: input.costEstimate,
    queuePosition: input.queuePosition,
    isStale: Boolean(input.isStale),
    conflictQueued: Boolean(input.conflictQueued),
    actionAvailability: input.actionAvailability || defaultActionAvailability(record),
  };
}
