import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { DelegateAttempt, DelegateTask, RecoveryInfo, TimeoutCategory } from "@octoclaw/contracts/delegate";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import type { LiveRoute } from "@octoclaw/policy/route";
import {
  advanceWorkflowToRunning,
  markWorkflowCheckpointEmitted,
  markWorkflowCompleted,
  markWorkflowFailed,
  markWorkflowTimedOut,
  renewWorkflowHeartbeat,
  startRuntimeWorkflow,
  type RuntimeWorkflowState,
} from "../core/workflow/index.js";
import {
  advanceAttemptStatus,
  projectTaskStatus,
} from "../core/delegate/index.js";
import {
  applyRecoveryHook,
  assessRecoveryNeed,
  type RecoveryAssessment,
} from "../core/recovery/index.js";
import { createOctoClawRuntimePlugin } from "../plugin.js";
import { policyState } from "../state/policy-state.js";
import {
  inferObserveMode,
  isDelegateAttempt,
  isDelegateTask,
  normalizeWorkspaceMode,
} from "./policy-routing-helpers.js";
import {
  type UnknownRecord,
  isRecord,
  asRecord,
  asString,
  asBoolean,
} from "../util/type-coercion.js";

type PolicyContextState = UnknownRecord & {
  prompt?: string;
  decision?: UnknownRecord;
  sessionBoundary?: { status: string; reason: string };
  canonicalSessionKey?: string;
  createdAt?: number;
  updatedAt?: number;
};

export function buildDelegateTaskContext(delegateTask: DelegateTask | null | undefined, currentAttempt: DelegateAttempt | null | undefined): UnknownRecord | undefined {
  if (!delegateTask) {
    return undefined;
  }

  return {
    delegateTaskId: delegateTask.delegateTaskId,
    currentAttemptId: currentAttempt?.attemptId ?? delegateTask.currentAttemptId,
    taskStatus: delegateTask.status,
  };
}

export function buildWorkflowScope(metadata: UnknownRecord = {}): ScopeMetadata {
  return {
    readScope: Array.isArray(metadata.readScope) ? metadata.readScope as ScopeMetadata["readScope"] : [],
    writeScope: Array.isArray(metadata.writeScope) ? metadata.writeScope as ScopeMetadata["writeScope"] : [],
    workspaceMode: normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode ?? "shared_workspace"),
    writeScopeSummary: asString(metadata.writeScopeSummary ?? metadata.write_scope_summary),
  };
}

function buildRuntimeTruthWorkflowStub(metadata: UnknownRecord = {}): RuntimeWorkflowState {
  const workspaceMode = normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode ?? "shared_workspace");
  const taskId = asString(
    metadata.taskId ?? metadata.task_id ?? metadata.native_task_id ?? metadata.requestId ?? metadata.request_id,
    "runtime-task",
  );
  const flowId = asString(metadata.flowId ?? metadata.flow_id ?? metadata.requestId ?? metadata.request_id, "runtime-flow");
  const requestId = asString(metadata.requestId ?? metadata.request_id ?? taskId, taskId);
  const claimOwner = asString(
    metadata.claimOwner ?? metadata.claim_owner ?? metadata.controllerId ?? metadata.controller_id,
    "runtime-wrapper",
  );
  const leaseDurationMs = 30_000;
  const observeMode = inferObserveMode(metadata);
  const decidedRoute: LiveRoute = observeMode || asBoolean(metadata.requiresDelegation)
    ? "delegate"
    : "reply";
  const decision: PolicyDecision = {
    route: decidedRoute,
    role: observeMode
      ? "observer_probe"
      : asBoolean(metadata.requiresDelegation)
        ? "worker_research"
        : "main_reply",
    coordinationMode: decidedRoute === "delegate" ? "solo_worker" : undefined,
    backend: "openclaw-native",
    executionProfile: observeMode
      ? "observer"
      : asBoolean(metadata.requiresDelegation)
        ? "worker"
        : "main",
    workspaceMode,
    modelProfile: observeMode
      ? "observer_probe"
      : asBoolean(metadata.requiresDelegation)
        ? "worker_research"
        : "direct_main",
    caps: {
      queueBudget: 1,
      maxWorkers: asBoolean(metadata.requiresDelegation) ? 1 : 0,
      latencyTarget: asBoolean(metadata.requiresDelegation) || observeMode ? "background" : "interactive",
      workerPool: observeMode
        ? "octoclaw-observer"
        : asBoolean(metadata.requiresDelegation)
          ? "octoclaw-research"
          : "octoclaw-main",
      capReason: "runtime_truth_stub",
    },
    admission: {
      admission: "allow",
      queueBudget: 1,
      maxWorkers: asBoolean(metadata.requiresDelegation) ? 1 : 0,
      latencyTarget: asBoolean(metadata.requiresDelegation) || observeMode ? "background" : "interactive",
      reason: "runtime_truth_stub",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };

  let workflow = startRuntimeWorkflow({
    requestId,
    taskId,
    flowId,
    decision,
    role: decision.role,
    decisionRef: `${requestId}:${taskId}:runtime_truth_stub`,
    provenanceSource: "runtime_orchestrator",
    claimOwner,
    leaseDurationMs,
    deadlineBudget: {
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 30_000,
      runtimeMs: 60_000,
      deliveryMs: 5_000,
    },
    scope: {
      readScope: Array.isArray(metadata.readScope) ? metadata.readScope as ScopeMetadata["readScope"] : [],
      writeScope: Array.isArray(metadata.writeScope) ? metadata.writeScope as ScopeMetadata["writeScope"] : [],
      workspaceMode,
      writeScopeSummary: asString(metadata.writeScopeSummary ?? metadata.write_scope_summary),
    },
  });

  if (observeMode) {
    return workflow;
  }
  workflow = advanceWorkflowToRunning(workflow, claimOwner);
  workflow = renewWorkflowHeartbeat(workflow);
  if (asBoolean(metadata.requiresDelegation)) {
    workflow = markWorkflowCheckpointEmitted(workflow);
  }
  return asBoolean(metadata.runtimeTimedOut)
    ? markWorkflowTimedOut(workflow)
    : asBoolean(metadata.runtimeFailed)
      ? markWorkflowFailed(workflow)
      : markWorkflowCompleted(workflow);
}

function isTerminalWorkflowPhase(phase: unknown): boolean {
  const value = asString(phase);
  return value === "completed" || value === "failed" || value === "timed_out";
}

function isTerminalDelegateStatus(status: unknown): boolean {
  const value = asString(status);
  return value === "completed"
    || value === "failed"
    || value === "timed_out"
    || value === "cancelled";
}

function timeoutCategoryForTrigger(trigger: RecoveryAssessment["trigger"]): TimeoutCategory | undefined {
  switch (trigger) {
    case "queue_deadline_exceeded":
      return "queue_timeout";
    case "start_deadline_exceeded":
      return "start_timeout";
    case "progress_deadline_exceeded":
      return "progress_timeout";
    case "runtime_deadline_exceeded":
      return "runtime_timeout";
    case "delivery_deadline_exceeded":
      return "delivery_timeout";
    default:
      return undefined;
  }
}

function recoveryInfoFromAssessment(assessment: RecoveryAssessment): RecoveryInfo {
  return {
    category: assessment.timedOut ? "timeout" : assessment.trigger === "lease_expired" ? "stale_claim" : "transient_error",
    reason: assessment.reason,
    retryEligible: !assessment.timedOut,
    maxRetries: assessment.timedOut ? 0 : 1,
    timeoutCategory: timeoutCategoryForTrigger(assessment.trigger),
  };
}

function applyRecoveryAssessmentToRuntimeTruth(
  runtimeTruth: UnknownRecord,
  workflow: RuntimeWorkflowState,
  assessment: RecoveryAssessment,
  binding: ReturnType<ReturnType<typeof createOctoClawRuntimePlugin>["readBinding"]>,
): UnknownRecord {
  const nextRuntimeTruth: UnknownRecord = {
    ...runtimeTruth,
    workflow,
    binding,
    recovery: {
      required: assessment.required,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      deadlineField: assessment.deadlineField,
      reason: assessment.reason,
      checkedAt: new Date().toISOString(),
      status: assessment.required ? "applied" : "healthy",
    },
  };

  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  if (!delegateTask || !delegateAttempt || !assessment.required) {
    return nextRuntimeTruth;
  }

  const recoveryInfo = recoveryInfoFromAssessment(assessment);
  const nextAttemptStatus = assessment.timedOut ? "timed_out" : "recovering";
  const nextAttempt = advanceAttemptStatus(delegateAttempt, nextAttemptStatus, {
    failureReason: assessment.timedOut ? assessment.reason : delegateAttempt.failureReason,
    recoveryInfo,
  });
  const nextTask = {
    ...delegateTask,
    status: projectTaskStatus(nextAttempt.status),
    updatedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    currentAttemptId: nextAttempt.attemptId,
  };

  nextRuntimeTruth.delegateAttempt = nextAttempt;
  nextRuntimeTruth.delegateTask = nextTask;
  nextRuntimeTruth.nativeTaskBinding = delegateAttempt.nativeBinding ?? runtimeTruth.nativeTaskBinding ?? null;
  return nextRuntimeTruth;
}

function buildRecoveredRuntimeTruth(
  workflowOrMetadata: UnknownRecord = {},
  options: { helperInvoker?: NativeHelperInvoker | null; now?: Date } = {},
): { workflow: RuntimeWorkflowState; binding: ReturnType<ReturnType<typeof createOctoClawRuntimePlugin>["readBinding"]>; recovery: UnknownRecord } {
  const helperInvoker = options.helperInvoker ?? (workflowOrMetadata.helperInvoker as NativeHelperInvoker | undefined) ?? undefined;
  const plugin = createOctoClawRuntimePlugin(helperInvoker ? { helperInvoker } : {});
  const workflow = isRecord(workflowOrMetadata.taskMaterialization)
    ? workflowOrMetadata as unknown as RuntimeWorkflowState
    : buildRuntimeTruthWorkflowStub(workflowOrMetadata);
  const now = options.now ?? new Date();
  const assessment = assessRecoveryNeed(workflow, now);
  const recoveredWorkflow = assessment.required ? applyRecoveryHook(workflow, now) : workflow;
  const binding = plugin.readBinding(recoveredWorkflow);
  return {
    workflow: recoveredWorkflow,
    binding,
    recovery: {
      required: assessment.required,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      deadlineField: assessment.deadlineField,
      reason: assessment.reason,
      checkedAt: now.toISOString(),
      status: assessment.required ? "applied" : "healthy",
    },
  };
}

export function buildRuntimeTruthMetadata(workflowOrMetadata: UnknownRecord = {}, options: { helperInvoker?: NativeHelperInvoker | null } = {}) {
  const { workflow, binding, recovery } = buildRecoveredRuntimeTruth(workflowOrMetadata, options);
  return {
    authority: "ts-native-adapter",
    pluginName: "octoclaw-runtime-ts",
    workflow,
    binding,
    recovery,
  };
}

function refreshRecoveryForStateEntry(
  key: string,
  state: PolicyContextState,
  now = new Date(),
): { updated: boolean; timedOut: boolean; summary: UnknownRecord | null } {
  const decision = asRecord(state.decision);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  const workflowCandidate = runtimeTruth.workflow;
  const hasActiveDelegate = Boolean(
    (delegateTask && !isTerminalDelegateStatus(delegateTask.status))
    || (delegateAttempt && !isTerminalDelegateStatus(delegateAttempt.status)),
  );
  if (!isRecord(workflowCandidate)) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (isTerminalWorkflowPhase(asRecord(workflowCandidate.lifecycle).phase) && !hasActiveDelegate) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (delegateTask && isTerminalDelegateStatus(delegateTask.status)) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (delegateAttempt && isTerminalDelegateStatus(delegateAttempt.status)) {
    return { updated: false, timedOut: false, summary: null };
  }

  const baseWorkflow = workflowCandidate as unknown as RuntimeWorkflowState;
  const recoveryPhase: RuntimeWorkflowState["lifecycle"]["phase"] = delegateAttempt?.status === "running"
    ? "running"
    : "checkpoint_pending";
  const workflow = isTerminalWorkflowPhase(asRecord(workflowCandidate.lifecycle).phase) && hasActiveDelegate
    ? {
      ...baseWorkflow,
      lifecycle: {
        ...baseWorkflow.lifecycle,
        phase: recoveryPhase,
        completedAt: undefined,
      },
    }
    : baseWorkflow;
  const assessment = assessRecoveryNeed(workflow, now);
  if (!assessment.required) {
    return { updated: false, timedOut: false, summary: null };
  }

  const helperInvoker = typeof state.helperInvoker === "function" ? state.helperInvoker as NativeHelperInvoker : null;
  const plugin = createOctoClawRuntimePlugin(helperInvoker ? { helperInvoker } : {});
  const recoveredWorkflow = applyRecoveryHook(workflow, now);
  const binding = plugin.readBinding(recoveredWorkflow);
  const nextRuntimeTruth = applyRecoveryAssessmentToRuntimeTruth(runtimeTruth, recoveredWorkflow, assessment, binding);
  const nextDecision: UnknownRecord = {
    ...decision,
    runtime_truth: nextRuntimeTruth,
  };
  const nextDelegateTaskContext = buildDelegateTaskContext(
    isDelegateTask(nextRuntimeTruth.delegateTask) ? nextRuntimeTruth.delegateTask : null,
    isDelegateAttempt(nextRuntimeTruth.delegateAttempt) ? nextRuntimeTruth.delegateAttempt : null,
  );
  if (nextDelegateTaskContext) {
    nextDecision.delegateTaskContext = nextDelegateTaskContext;
  }

  policyState.set(key, {
    ...state,
    decision: nextDecision,
    delegateTaskContext: nextDelegateTaskContext,
    updatedAt: Date.now(),
  });

  return {
    updated: true,
    timedOut: assessment.timedOut,
    summary: {
      stateKey: key,
      taskId: asString(binding.taskId),
      flowId: asString(binding.flowId),
      delegateTaskId: delegateTask?.delegateTaskId ?? null,
      attemptId: delegateAttempt?.attemptId ?? null,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      reason: assessment.reason,
      deadlineField: assessment.deadlineField,
      checkedAt: now.toISOString(),
    },
  };
}

export function checkActiveTaskRecovery(options: { taskId?: string; now?: Date } = {}): {
  checkedAt: string;
  updatedCount: number;
  timedOutCount: number;
  recoveries: UnknownRecord[];
} {
  const now = options.now ?? new Date();
  const targetTaskId = asString(options.taskId);
  const recoveries: UnknownRecord[] = [];
  let updatedCount = 0;
  let timedOutCount = 0;

  for (const { key, state } of policyState.entries()) {
    const decision = asRecord(state.decision);
    const runtimeTruth = asRecord(decision.runtime_truth);
    if (targetTaskId) {
      const binding = asRecord(runtimeTruth.binding);
      const delegateTask = asRecord(runtimeTruth.delegateTask);
      const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
      const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
      const matches = asString(binding.taskId) === targetTaskId
        || asString(binding.flowId) === targetTaskId
        || asString(asRecord(delegateAttempt.nativeBinding).nativeTaskId) === targetTaskId
        || asString(asRecord(delegateAttempt.nativeBinding).nativeFlowId) === targetTaskId
        || asString(nativeTaskBinding.nativeTaskId) === targetTaskId
        || asString(nativeTaskBinding.nativeFlowId) === targetTaskId
        || asString(delegateTask.delegateTaskId) === targetTaskId;
      if (!matches) {
        continue;
      }
    }

    const result = refreshRecoveryForStateEntry(key, state as PolicyContextState, now);
    if (!result.updated || !result.summary) {
      continue;
    }
    updatedCount += 1;
    if (result.timedOut) {
      timedOutCount += 1;
    }
    recoveries.push(result.summary);
  }

  return {
    checkedAt: now.toISOString(),
    updatedCount,
    timedOutCount,
    recoveries,
  };
}
