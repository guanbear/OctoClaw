import type {
  AttemptStatus,
  DelegateAttempt,
  DelegateProgressEvent,
  DelegateProgressEventType,
  DelegateTask,
  DelegateTaskStatus,
  NativeTaskBinding,
  RecoveryInfo,
  ResumePacket,
} from "@octoclaw/contracts/delegate";
import type {
  BackendType,
  CoordinationMode,
  ModelProfile,
  ScopeMetadata,
  WorkspaceMode,
} from "@octoclaw/contracts/schemas";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";

function now(): string {
  return new Date().toISOString();
}

function sanitizeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "delegate";
}

function buildDelegateTaskId(sessionId: string, createdAt: string): string {
  return `delegate-task:${sanitizeIdPart(sessionId)}:${Date.parse(createdAt)}`;
}

function buildAttemptId(delegateTaskId: string, generation: number): string {
  return `${delegateTaskId}:attempt:${generation}`;
}

function buildProgressEventId(delegateTaskId: string, attemptId: string, eventType: DelegateProgressEventType, createdAt: string): string {
  return `${delegateTaskId}:event:${sanitizeIdPart(attemptId)}:${eventType}:${Date.parse(createdAt)}`;
}

export function createDelegateTask(input: {
  sessionId: string;
  role: string;
  coordinationMode: CoordinationMode;
  goal: string;
  scope: ScopeMetadata;
}): DelegateTask {
  const createdAt = now();
  return {
    ...buildContractEnvelope("projection", createdAt),
    ...input.scope,
    kind: "projection",
    delegateTaskId: buildDelegateTaskId(input.sessionId, createdAt),
    sessionId: input.sessionId,
    route: "delegate",
    role: input.role,
    coordinationMode: input.coordinationMode,
    goal: input.goal,
    status: "pending",
    currentAttemptId: null,
    totalAttempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export function startDelegateAttempt(
  task: DelegateTask,
  input: {
    nativeFlowId: string;
    nativeTaskId: string;
    claimOwner: string;
    modelProfile: ModelProfile;
    backend: BackendType;
    workspaceMode: WorkspaceMode;
  },
): { task: DelegateTask; attempt: DelegateAttempt; binding: NativeTaskBinding } {
  const createdAt = now();
  const attemptGeneration = task.totalAttempts + 1;
  const attemptId = buildAttemptId(task.delegateTaskId, attemptGeneration);
  const binding: NativeTaskBinding = {
    delegateTaskId: task.delegateTaskId,
    attemptId,
    nativeFlowId: input.nativeFlowId,
    nativeTaskId: input.nativeTaskId,
    claimOwner: input.claimOwner,
    resumeGeneration: attemptGeneration,
    boundAt: createdAt,
  };
  const attempt: DelegateAttempt = {
    ...buildContractEnvelope("truth", createdAt),
    kind: "truth",
    attemptId,
    delegateTaskId: task.delegateTaskId,
    attemptGeneration,
    nativeBinding: binding,
    status: "queued",
    claimOwner: input.claimOwner,
    modelProfile: input.modelProfile,
    backend: input.backend,
    workspaceMode: input.workspaceMode,
    queuedAt: createdAt,
  };
  const nextTask: DelegateTask = {
    ...task,
    status: projectTaskStatus(attempt.status),
    currentAttemptId: attempt.attemptId,
    totalAttempts: attemptGeneration,
    updatedAt: createdAt,
    lastEventAt: createdAt,
  };
  return {
    task: nextTask,
    attempt,
    binding,
  };
}

export function advanceAttemptStatus(
  attempt: DelegateAttempt,
  nextStatus: AttemptStatus,
  extra?: { failureReason?: string; recoveryInfo?: RecoveryInfo },
): DelegateAttempt {
  const eventAt = now();
  const nextAttempt: DelegateAttempt = {
    ...attempt,
    status: nextStatus,
  };

  if (nextStatus === "queued") {
    nextAttempt.queuedAt = attempt.queuedAt || eventAt;
  }

  if (nextStatus === "running") {
    nextAttempt.queuedAt = attempt.queuedAt || eventAt;
    nextAttempt.startedAt = attempt.startedAt || eventAt;
  }

  if (["completed", "failed", "timed_out", "cancelled"].includes(nextStatus)) {
    nextAttempt.completedAt = eventAt;
  }

  if (extra?.failureReason !== undefined) {
    nextAttempt.failureReason = extra.failureReason;
  }

  if (extra?.recoveryInfo !== undefined) {
    nextAttempt.recoveryInfo = extra.recoveryInfo;
  }

  return nextAttempt;
}

export function recordProgressEvent(
  delegateTaskId: string,
  attemptId: string,
  eventType: DelegateProgressEventType,
  summary: string,
): DelegateProgressEvent {
  const createdAt = now();
  return {
    ...buildContractEnvelope("artifact", createdAt),
    kind: "artifact",
    eventId: buildProgressEventId(delegateTaskId, attemptId, eventType, createdAt),
    delegateTaskId,
    attemptId,
    eventType,
    eventAt: createdAt,
    summary,
  };
}

export function retryDelegateAttempt(
  task: DelegateTask,
  failedAttempt: DelegateAttempt,
  input: {
    nativeFlowId: string;
    nativeTaskId: string;
    claimOwner: string;
    modelProfile: ModelProfile;
    backend: BackendType;
    workspaceMode: WorkspaceMode;
  },
): { task: DelegateTask; attempt: DelegateAttempt; binding: NativeTaskBinding } {
  if (failedAttempt.delegateTaskId !== task.delegateTaskId) {
    throw new Error("delegate_task_mismatch");
  }
  return startDelegateAttempt(task, input);
}

export function buildResumePacket(
  task: DelegateTask,
  attempt: DelegateAttempt,
  binding: NativeTaskBinding,
): ResumePacket {
  const createdAt = now();
  return {
    ...buildContractEnvelope("artifact", createdAt),
    kind: "artifact",
    delegateTaskId: task.delegateTaskId,
    attemptId: attempt.attemptId,
    nativeBinding: binding,
    goal: task.goal,
    accumulatedArtifactRefs: [],
    stateSnapshot: {
      taskStatus: task.status,
      currentAttemptId: task.currentAttemptId,
      totalAttempts: task.totalAttempts,
      attemptStatus: attempt.status,
      attemptGeneration: attempt.attemptGeneration,
      claimOwner: attempt.claimOwner,
      backend: attempt.backend,
      modelProfile: attempt.modelProfile,
      workspaceMode: attempt.workspaceMode,
    },
    pendingSlots: [],
    recoveryInfo: attempt.recoveryInfo,
  };
}

export function projectTaskStatus(attemptStatus: AttemptStatus | null): DelegateTaskStatus {
  if (attemptStatus === null || attemptStatus === "pending") {
    return "pending";
  }
  if (attemptStatus === "completed") {
    return "completed";
  }
  if (attemptStatus === "failed") {
    return "failed";
  }
  if (attemptStatus === "timed_out") {
    return "timed_out";
  }
  if (attemptStatus === "recovering") {
    return "recovering";
  }
  if (attemptStatus === "cancelled") {
    return "cancelled";
  }
  return "active";
}
