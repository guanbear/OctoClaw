import type { AnomalyNotice, DelegateArtifactRef, NativeBindingRef, SpawnBackend, SpawnMode, WorkContract } from "./work-contract.js";

export const TASK_STATUS_PROJECTION_SCHEMA_VERSION = "octoclaw.task_status_projection/v1" as const;
export const MULTI_TASK_STATUS_PROJECTION_SCHEMA_VERSION = "octoclaw.multi_task_status_projection/v1" as const;

export type TaskProjectionStatus =
  | "registered"
  | "materializing"
  | "queued"
  | "running"
  | "blocked"
  | "deliverable_ready"
  | "completed"
  | "failed"
  | "timed_out"
  | "canceled";

export type ProjectedTaskStatus = TaskProjectionStatus;
export type TaskProjectionAction = "open" | "details" | "retry" | "cancel" | "resume" | "copy_ref";
export type TaskProjectionScope = "thread" | "user" | "workspace" | "system";
export type TaskProjectionRoute = "reply" | "delegate" | "compound";

export interface TaskStatusProjectionInput {
  contract: WorkContract;
  now?: string | Date;
  heartbeatAt?: string | Date;
  staleAfterMs?: number;
  deliveryAcknowledged?: boolean;
  finalResultExists?: boolean;
  failureCode?: string;
  failureMessage?: string;
  requestId?: string;
  modelId?: string;
  fallbackModelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  materializedAt?: string | Date;
  queuedAt?: string | Date;
  startedAt?: string | Date;
  lastProgressAt?: string | Date;
  deliverableReadyAt?: string | Date;
  completedAt?: string | Date;
  failedAt?: string | Date;
  lastProgressSummary?: string;
  resultSummary?: string;
}

export interface TaskStatusArtifactRef {
  artifactId: string;
  artifactKind?: string;
  uri?: string;
  title?: string;
  summary?: string;
}

export interface TaskStatusProjection {
  schemaVersion: typeof TASK_STATUS_PROJECTION_SCHEMA_VERSION;
  projectionId: string;
  generatedAt: string;
  requestId: string;
  flowId: string;
  taskId: string;
  workContractId?: string;
  parentThreadKey?: string;
  title: string;
  summary: string;
  taskSummary: string;
  route: TaskProjectionRoute;
  role: string;
  coordinationMode?: string;
  backend: string;
  modelProfile: string;
  modelId?: string;
  fallbackModelId?: string;
  status: TaskProjectionStatus;
  statusReason?: string;
  success: boolean;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
  materializedAt?: string;
  queuedAt?: string;
  startedAt?: string;
  lastProgressAt?: string;
  deliverableReadyAt?: string;
  completedAt?: string;
  failedAt?: string;
  elapsedMs: number;
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  nativeFlowRevision?: number;
  nativeFlowExpectedRevision?: number;
  childSessionKey?: string;
  childSessionId?: string;
  runId?: string;
  childRunId?: string;
  lastProgressSummary?: string;
  resultSummary?: string;
  artifactRefs: TaskStatusArtifactRef[];
  artifactRefIds: string[];
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  actions: TaskProjectionAction[];
  nativeBinding?: NativeBindingRef;
  latestAnomalyNotice?: AnomalyNotice;
  openclawRunId?: string;
  spawnIntentId?: string;
  spawnBackend?: SpawnBackend;
  spawnMode?: SpawnMode;
}

export interface MultiTaskStatusProjection {
  schemaVersion: typeof MULTI_TASK_STATUS_PROJECTION_SCHEMA_VERSION;
  projectionId: string;
  generatedAt: string;
  scope: TaskProjectionScope;
  threadKey?: string;
  userKey?: string;
  workspaceKey?: string;
  activeCount: number;
  blockedCount: number;
  completedRecentCount: number;
  failedRecentCount: number;
  totalEstimatedCostUsd?: number;
  totalActualCostUsd?: number;
  tasks: TaskStatusProjection[];
  counts: Record<TaskProjectionStatus, number>;
}

function timestampMs(value: string | Date | undefined): number | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function iso(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function artifactRefs(refs: DelegateArtifactRef[] | undefined): TaskStatusArtifactRef[] {
  return (refs ?? []).map((ref) => ({
    artifactId: ref.artifactId,
    ...(ref.artifactKind ? { artifactKind: ref.artifactKind } : {}),
    ...(ref.uri ? { uri: ref.uri } : {}),
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.summary ? { summary: ref.summary } : {}),
  }));
}

function projectStatus(input: TaskStatusProjectionInput): TaskProjectionStatus {
  const { contract, deliveryAcknowledged, finalResultExists } = input;
  const dispatchExecuted = Boolean(contract.telemetry.dispatchExecuted);
  const spawnExecuted = Boolean(contract.telemetry.spawnExecuted);
  const resultMaterialized = Boolean(contract.telemetry.resultMaterialized);

  if (contract.status === "failed") return "failed";
  if (contract.status === "cancelled") return "canceled";
  if (resultMaterialized && deliveryAcknowledged) return "completed";
  if (finalResultExists || (resultMaterialized && contract.telemetry.deliveryStatus === "pending")) return "deliverable_ready";
  if (!dispatchExecuted) return contract.delegate?.nativeBinding ? "materializing" : "registered";
  if (!spawnExecuted) return "queued";

  const now = timestampMs(input.now) ?? Date.now();
  const heartbeat = timestampMs(input.heartbeatAt ?? input.lastProgressAt);
  const staleAfterMs = input.staleAfterMs ?? 5 * 60 * 1000;
  if (heartbeat !== undefined && now - heartbeat >= staleAfterMs) return "timed_out";
  if (contract.status === "blocked") return "blocked";
  return "running";
}

function statusReason(status: TaskProjectionStatus, input: TaskStatusProjectionInput): string {
  if (status === "registered") return "work_contract_registered_without_dispatch_evidence";
  if (status === "materializing") return "native_flow_exists_without_dispatch_evidence";
  if (status === "queued") return "dispatch_executed_without_spawn_evidence";
  if (status === "running") {
    return input.heartbeatAt || input.lastProgressAt
      ? "spawn_evidence_with_fresh_progress"
      : "spawn_evidence_without_progress_timestamp";
  }
  if (status === "timed_out") return "heartbeat_stale_without_final_result";
  if (status === "deliverable_ready") return "final_result_exists_delivery_pending";
  if (status === "completed") return "delivery_acknowledged_and_result_materialized";
  if (status === "failed") return input.failureCode ?? "failure_receipt";
  if (status === "canceled") return "cancelled_by_contract";
  return status;
}

function actionsForStatus(status: TaskProjectionStatus): TaskProjectionAction[] {
  const actions: TaskProjectionAction[] = ["details", "copy_ref"];
  if (["materializing", "queued", "running", "blocked", "timed_out"].includes(status)) actions.push("cancel");
  if (["blocked", "timed_out", "failed"].includes(status)) actions.push("retry");
  if (["queued", "blocked", "timed_out"].includes(status)) actions.push("resume");
  if (["running", "deliverable_ready", "completed"].includes(status)) actions.push("open");
  return actions;
}

export function buildTaskStatusProjection(input: TaskStatusProjectionInput): TaskStatusProjection {
  const { contract } = input;
  const createdAtMs = timestampMs(contract.createdAt) ?? timestampMs(contract.updatedAt) ?? Date.now();
  const nowMs = timestampMs(input.now) ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const nativeBinding = contract.delegate?.nativeBinding ?? undefined;
  const nativeRefs = contract.nativeSpawnRefs;
  const status = projectStatus(input);
  const artifacts = artifactRefs(contract.delegate?.artifactRefs);
  const taskSummary = contract.mainContext.summary || contract.userAsk;
  const flowId = nativeBinding?.flowId ?? nativeRefs?.openclawFlowId ?? contract.telemetry.nativeFlowId ?? contract.workContractId;
  const taskId = nativeBinding?.taskId ?? nativeBinding?.nativeTaskId ?? nativeRefs?.openclawTaskId ?? contract.telemetry.nativeTaskId ?? contract.delegate?.delegateTaskId ?? contract.workContractId;
  const role = contract.delegate?.role ?? (contract.route === "reply" ? "main" : "default");
  const backend = nativeBinding?.controllerId ?? (contract.route === "reply" ? "octoclaw-main" : "unknown");
  const modelProfile = contract.delegate?.modelProfile || (contract.route === "reply" ? "direct_main" : "unknown");

  return {
    schemaVersion: TASK_STATUS_PROJECTION_SCHEMA_VERSION,
    projectionId: `task-status:${contract.workContractId}:${generatedAt}`,
    generatedAt,
    requestId: input.requestId ?? contract.turnId,
    flowId,
    taskId,
    workContractId: contract.workContractId,
    parentThreadKey: contract.continuity.threadBindingKey,
    title: taskSummary,
    summary: contract.mainContext.statusLine || taskSummary,
    taskSummary,
    route: contract.route,
    role,
    coordinationMode: contract.delegate?.coordinationMode,
    backend,
    modelProfile,
    modelId: input.modelId,
    fallbackModelId: input.fallbackModelId,
    status,
    statusReason: statusReason(status, input),
    success: status === "completed",
    failureCode: input.failureCode ?? (contract.status === "failed" ? contract.telemetry.nativeFlowMutationError : undefined),
    failureMessage: input.failureMessage,
    createdAt: contract.createdAt,
    materializedAt: iso(input.materializedAt),
    queuedAt: iso(input.queuedAt),
    startedAt: iso(input.startedAt),
    lastProgressAt: iso(input.lastProgressAt ?? input.heartbeatAt),
    deliverableReadyAt: status === "deliverable_ready" ? iso(input.deliverableReadyAt ?? input.now) : iso(input.deliverableReadyAt),
    completedAt: status === "completed" ? iso(input.completedAt ?? input.now) : iso(input.completedAt),
    failedAt: status === "failed" ? iso(input.failedAt ?? input.now) : iso(input.failedAt),
    elapsedMs: Math.max(0, nowMs - createdAtMs),
    dispatchExecuted: Boolean(contract.telemetry.dispatchExecuted),
    spawnExecuted: Boolean(contract.telemetry.spawnExecuted),
    resultMaterialized: Boolean(contract.telemetry.resultMaterialized),
    nativeFlowRevision: nativeBinding?.revision ?? contract.telemetry.nativeFlowRevision,
    nativeFlowExpectedRevision: nativeBinding?.expectedRevision ?? contract.telemetry.nativeFlowExpectedRevision,
    childSessionKey: nativeBinding?.childSessionKey ?? nativeRefs?.childSessionKey ?? contract.continuity.preferredChildSessionKey,
    childSessionId: contract.continuity.preferredChildSessionId,
    runId: nativeBinding?.runId ?? nativeRefs?.openclawRunId ?? contract.continuity.preferredRunId,
    childRunId: nativeBinding?.childRunId ?? contract.telemetry.childRunId,
    lastProgressSummary: input.lastProgressSummary,
    resultSummary: input.resultSummary,
    artifactRefs: artifacts,
    artifactRefIds: artifacts.map((ref) => ref.artifactId),
    estimatedCostUsd: contract.telemetry.estimatedCostUsd,
    actualCostUsd: contract.telemetry.actualCostUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    actions: actionsForStatus(status),
    nativeBinding,
    openclawRunId: nativeBinding?.runId ?? contract.nativeSpawnRefs?.openclawRunId,
    spawnIntentId: contract.nativeSpawnRefs?.spawnIntentId,
    spawnBackend: contract.nativeSpawnRefs?.spawnBackend,
    spawnMode: contract.nativeSpawnRefs?.spawnMode,
  };
}

export function buildMultiTaskStatusProjection(
  inputs: TaskStatusProjectionInput[],
  generatedAt: string | Date = new Date(),
  scope: TaskProjectionScope = "thread",
): MultiTaskStatusProjection {
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : generatedAt;
  const tasks = inputs.map((input) => buildTaskStatusProjection({ now: generatedAt, ...input }));
  const counts = tasks.reduce<Record<TaskProjectionStatus, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {} as Record<TaskProjectionStatus, number>);
  const activeStatuses = new Set<TaskProjectionStatus>(["materializing", "queued", "running", "blocked", "timed_out", "deliverable_ready"]);

  return {
    schemaVersion: MULTI_TASK_STATUS_PROJECTION_SCHEMA_VERSION,
    projectionId: `multi-task-status:${scope}:${generatedAtIso}`,
    generatedAt: generatedAtIso,
    scope,
    threadKey: scope === "thread" ? inputs[0]?.contract.continuity.threadBindingKey : undefined,
    activeCount: tasks.filter((task) => activeStatuses.has(task.status)).length,
    blockedCount: tasks.filter((task) => task.status === "blocked" || task.status === "timed_out").length,
    completedRecentCount: tasks.filter((task) => task.status === "completed").length,
    failedRecentCount: tasks.filter((task) => task.status === "failed").length,
    totalEstimatedCostUsd: tasks.reduce((sum, task) => sum + (task.estimatedCostUsd ?? 0), 0),
    totalActualCostUsd: tasks.reduce((sum, task) => sum + (task.actualCostUsd ?? 0), 0),
    tasks,
    counts,
  };
}
