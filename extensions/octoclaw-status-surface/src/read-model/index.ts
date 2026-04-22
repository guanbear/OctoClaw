import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type {
  DelegateAttempt,
  DelegateProgressEvent,
  DelegateTask,
  NativeTaskBinding,
} from "@octoclaw/contracts/delegate";
import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import type { RuntimeStateDetailsSurface } from "@octoclaw/runtime/state-surface";

export interface StatusSurfaceProjectionInput {
  record: RuntimeStateSurfaceRecord;
  delegateTask?: DelegateTask;
  delegateAttempt?: DelegateAttempt;
  nativeBinding?: NativeTaskBinding;
  progressEvents?: DelegateProgressEvent[];
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
  delegateTaskId?: string;
  attemptId?: string;
  attemptStatus?: string;
  taskStatus?: string;
  queuePosition?: number;
  workerPool: string;
  substrateSummary: string;
  claimOwner: string;
  leaseState?: string;
  isStale: boolean;
  conflictQueued: boolean;
}

export interface DetailsSurfaceProjection extends RuntimeStateDetailsSurface {
  delegateTaskId?: string;
  attemptId?: string;
  attemptGeneration?: number;
  attemptStatus?: string;
  totalAttempts?: number;
  taskStatus?: string;
  leaseState?: string;
  modelSummary?: string;
  costEstimate?: string;
  queuePosition?: number;
  isStale: boolean;
  conflictQueued: boolean;
  actionAvailability: string[];
}

function isNativeTerminalState(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "completed"
    || normalized === "failed"
    || normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "timed_out"
    || normalized === "timed-out";
}

function mapTerminalSubstrateToAttemptStatus(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "timed_out" || normalized === "timed-out") return "timed_out";
  return undefined;
}

function mapTerminalSubstrateToTaskStatus(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "timed_out" || normalized === "timed-out") return "timed_out";
  return undefined;
}

function resolveDisplayState(input: StatusSurfaceProjectionInput): string {
  const substrateState = input.record.substrateState;
  if (isNativeTerminalState(substrateState)) {
    return mapTerminalSubstrateToAttemptStatus(substrateState) || substrateState;
  }
  return input.delegateAttempt?.status || substrateState;
}

function resolveAttemptStatus(input: StatusSurfaceProjectionInput): string | undefined {
  const substrateState = input.record.substrateState;
  if (isNativeTerminalState(substrateState)) {
    return mapTerminalSubstrateToAttemptStatus(substrateState);
  }
  return input.delegateAttempt?.status;
}

function resolveTaskStatus(input: StatusSurfaceProjectionInput): string | undefined {
  const substrateState = input.record.substrateState;
  if (isNativeTerminalState(substrateState)) {
    return mapTerminalSubstrateToTaskStatus(substrateState);
  }
  return input.delegateTask?.status;
}

function delegateSubstrateSummary(input: StatusSurfaceProjectionInput): string {
  const attemptStatus = resolveAttemptStatus(input);
  return `${input.record.runtime} ${input.record.syncMode} ${attemptStatus || input.record.substrateState}`.trim();
}

function defaultRoute(record: RuntimeStateSurfaceRecord, delegateTask?: DelegateTask): string {
  if (delegateTask) return delegateTask.route;
  const identityRoute = (record as RuntimeStateSurfaceRecord & { identity?: { route?: string } }).identity?.route;
  if (typeof identityRoute === "string" && identityRoute.trim()) return identityRoute;
  return typeof record.truth.requestId === "string" && record.truth.requestId ? "delegate" : "reply";
}

function isTaskStale(delegateTask?: DelegateTask, fallback = false): boolean {
  if (!delegateTask) return fallback;
  return ["failed", "timed_out", "recovering", "cancelled"].includes(delegateTask.status);
}

function resolveStaleState(input: StatusSurfaceProjectionInput): boolean {
  if (isNativeTerminalState(input.record.substrateState)) {
    return false;
  }
  return isTaskStale(input.delegateTask, Boolean(input.isStale));
}

function buildTimelinePreview(progressEvents?: DelegateProgressEvent[]): StatusSurfaceViewModel["timelinePreview"] {
  if (!Array.isArray(progressEvents) || progressEvents.length === 0) return [];
  return progressEvents.map((event) => ({
    eventType: event.eventType,
    eventAt: event.eventAt,
    summary: event.summary,
  }));
}

function defaultWorkerPool(record: RuntimeStateSurfaceRecord): string {
  if (record.runtime === "openclaw-native") {
    return record.syncMode === "managed" ? "octoclaw-worker" : "octoclaw-runtime";
  }
  return "octoclaw-runtime";
}

function defaultActionAvailability(record: RuntimeStateSurfaceRecord): string[] {
  if (record.substrateState === "planned") return ["status", "details"];
  return ["status", "details", "queue", "timeline"];
}

export function buildStatusProjection(input: StatusSurfaceProjectionInput): StatusSurfaceViewModel {
  const { record, delegateTask, nativeBinding, progressEvents } = input;
  const route = input.route || defaultRoute(record, delegateTask);
  return {
    ...buildContractEnvelope("projection"),
    taskId: nativeBinding?.nativeTaskId || record.truth.taskId,
    flowId: nativeBinding?.nativeFlowId || record.truth.flowId,
    state: resolveDisplayState(input),
    route,
    role: delegateTask?.role || (route === "reply" ? "main_reply" : "worker_research"),
    coordinationMode: delegateTask?.coordinationMode || (route === "delegate" ? "solo_worker" : ""),
    backendSummary: record.runtime,
    workerPool: input.workerPool || defaultWorkerPool(record),
    substrateSummary: delegateSubstrateSummary(input),
    actionAvailability: input.actionAvailability || defaultActionAvailability(record),
    queuePosition: input.queuePosition ?? 0,
    modelSummary: input.modelSummary || "unreported",
    costEstimate: input.costEstimate || "unreported",
    claimOwner: record.ownership.claimOwner,
    leaseState: (input.leaseState as StatusSurfaceViewModel["leaseState"]) || "active",
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary || "none",
    threadCount: 1,
    advisorUsageSummary: "none",
    timelinePreview: buildTimelinePreview(progressEvents),
  };
}

export function buildQueueProjection(input: StatusSurfaceProjectionInput): QueueSurfaceProjection {
  const { record, delegateAttempt, delegateTask, nativeBinding } = input;
  return {
    taskId: nativeBinding?.nativeTaskId || record.truth.taskId,
    flowId: nativeBinding?.nativeFlowId || record.truth.flowId,
    delegateTaskId: delegateTask?.delegateTaskId || nativeBinding?.delegateTaskId,
    attemptId: delegateAttempt?.attemptId || nativeBinding?.attemptId,
    attemptStatus: resolveAttemptStatus(input),
    taskStatus: resolveTaskStatus(input),
    queuePosition: input.queuePosition,
    workerPool: input.workerPool || defaultWorkerPool(record),
    substrateSummary: delegateSubstrateSummary(input),
    claimOwner: record.ownership.claimOwner,
    leaseState: input.leaseState,
    isStale: resolveStaleState(input),
    conflictQueued: Boolean(input.conflictQueued),
  };
}

export function buildDetailsProjection(input: StatusSurfaceProjectionInput): DetailsSurfaceProjection {
  const { record, delegateAttempt, delegateTask, nativeBinding } = input;
  return {
    taskId: nativeBinding?.nativeTaskId || record.truth.taskId,
    flowId: nativeBinding?.nativeFlowId || record.truth.flowId,
    substrateState: record.substrateState,
    substrateRevision: record.substrateRevision,
    syncMode: record.syncMode,
    runtime: record.runtime,
    claimOwner: record.ownership.claimOwner,
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary,
    summary: delegateSubstrateSummary(input),
    truth: record.truth,
    projection: record.projection,
    delegateTaskId: delegateTask?.delegateTaskId || nativeBinding?.delegateTaskId,
    attemptId: delegateAttempt?.attemptId || nativeBinding?.attemptId,
    attemptGeneration: delegateAttempt?.attemptGeneration,
    attemptStatus: resolveAttemptStatus(input),
    totalAttempts: delegateTask?.totalAttempts,
    taskStatus: resolveTaskStatus(input),
    leaseState: input.leaseState,
    modelSummary: input.modelSummary,
    costEstimate: input.costEstimate,
    queuePosition: input.queuePosition,
    isStale: resolveStaleState(input),
    conflictQueued: Boolean(input.conflictQueued),
    actionAvailability: input.actionAvailability || defaultActionAvailability(record),
  };
}
