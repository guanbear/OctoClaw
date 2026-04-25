import type { DelegateArtifactRef, NativeBindingRef, WorkContract } from "./work-contract.js";

export type ProjectedTaskStatus =
  | "registered"
  | "materializing"
  | "queued"
  | "running"
  | "blocked"
  | "timed_out"
  | "deliverable_ready"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskStatusProjectionInput {
  contract: WorkContract;
  now?: string | Date;
  heartbeatAt?: string | Date;
  staleAfterMs?: number;
  deliveryAcknowledged?: boolean;
  finalResultExists?: boolean;
  failureCode?: string;
  failureMessage?: string;
}

export interface TaskStatusArtifactRef {
  artifactId: string;
  artifactKind?: string;
  uri?: string;
  title?: string;
  summary?: string;
}

export interface TaskStatusProjection {
  workContractId: string;
  taskSummary: string;
  elapsedMs: number;
  modelProfile?: string;
  backend?: string;
  status: ProjectedTaskStatus;
  success: boolean;
  failureCode?: string;
  failureMessage?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  artifactRefs: TaskStatusArtifactRef[];
  childSessionKey?: string;
  childSessionId?: string;
  runId?: string;
  childRunId?: string;
  nativeBinding?: NativeBindingRef;
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
}

export interface MultiTaskStatusProjection {
  generatedAt: string;
  tasks: TaskStatusProjection[];
  counts: Record<ProjectedTaskStatus, number>;
}

function timestampMs(value: string | Date | undefined): number | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
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

function projectStatus(input: TaskStatusProjectionInput): ProjectedTaskStatus {
  const { contract, deliveryAcknowledged, finalResultExists } = input;
  const dispatchExecuted = Boolean(contract.telemetry.dispatchExecuted);
  const spawnExecuted = Boolean(contract.telemetry.spawnExecuted);
  const resultMaterialized = Boolean(contract.telemetry.resultMaterialized);

  if (contract.status === "failed") return "failed";
  if (contract.status === "cancelled") return "cancelled";
  if (resultMaterialized && deliveryAcknowledged) return "completed";
  if (finalResultExists || (resultMaterialized && contract.telemetry.deliveryStatus === "pending")) return "deliverable_ready";
  if (!dispatchExecuted) return contract.delegate?.nativeBinding ? "materializing" : "registered";
  if (!spawnExecuted) return "queued";

  const now = timestampMs(input.now) ?? Date.now();
  const heartbeat = timestampMs(input.heartbeatAt ?? contract.updatedAt);
  const staleAfterMs = input.staleAfterMs ?? 5 * 60 * 1000;
  if (heartbeat !== undefined && now - heartbeat > staleAfterMs) return "timed_out";
  if (contract.status === "blocked") return "blocked";
  return "running";
}

export function buildTaskStatusProjection(input: TaskStatusProjectionInput): TaskStatusProjection {
  const { contract } = input;
  const createdAt = timestampMs(contract.createdAt) ?? timestampMs(contract.updatedAt) ?? Date.now();
  const now = timestampMs(input.now) ?? Date.now();
  const nativeBinding = contract.delegate?.nativeBinding ?? undefined;
  const status = projectStatus(input);
  const childRunId = nativeBinding?.childRunId ?? contract.telemetry.childRunId;

  return {
    workContractId: contract.workContractId,
    taskSummary: contract.mainContext.summary || contract.userAsk,
    elapsedMs: Math.max(0, now - createdAt),
    modelProfile: contract.delegate?.modelProfile,
    backend: nativeBinding?.controllerId,
    status,
    success: status === "completed",
    failureCode: input.failureCode ?? (contract.status === "failed" ? contract.telemetry.nativeFlowMutationError : undefined),
    failureMessage: input.failureMessage,
    estimatedCostUsd: contract.telemetry.estimatedCostUsd,
    actualCostUsd: contract.telemetry.actualCostUsd,
    artifactRefs: artifactRefs(contract.delegate?.artifactRefs),
    childSessionKey: nativeBinding?.childSessionKey ?? contract.continuity.preferredChildSessionKey,
    childSessionId: contract.continuity.preferredChildSessionId,
    runId: nativeBinding?.runId ?? contract.continuity.preferredRunId,
    childRunId,
    nativeBinding,
    dispatchExecuted: Boolean(contract.telemetry.dispatchExecuted),
    spawnExecuted: Boolean(contract.telemetry.spawnExecuted),
    resultMaterialized: Boolean(contract.telemetry.resultMaterialized),
  };
}

export function buildMultiTaskStatusProjection(
  inputs: TaskStatusProjectionInput[],
  generatedAt: string | Date = new Date(),
): MultiTaskStatusProjection {
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : generatedAt;
  const tasks = inputs.map((input) => buildTaskStatusProjection({ now: generatedAt, ...input }));
  const counts = tasks.reduce<Record<ProjectedTaskStatus, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {} as Record<ProjectedTaskStatus, number>);

  return { generatedAt: generatedAtIso, tasks, counts };
}
