import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { DelegateAttempt, DelegateTask } from "@octoclaw/contracts/delegate";
import { inferObserveMode, isDelegateAttempt, isDelegateTask, normalizeWorkspaceMode } from "./policy-routing-helpers.js";
import { type UnknownRecord, asRecord, asString, asBoolean } from "../util/type-coercion.js";

export function buildDelegateTaskContext(delegateTask: DelegateTask | null | undefined, currentAttempt: DelegateAttempt | null | undefined): UnknownRecord | undefined {
  if (!delegateTask) return undefined;
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

export function buildRuntimeTruthMetadata(workflowOrMetadata: UnknownRecord = {}) {
  const metadata = asRecord(workflowOrMetadata);
  const taskId = asString(metadata.taskId ?? metadata.task_id ?? metadata.native_task_id ?? metadata.requestId ?? metadata.request_id, "runtime-task");
  const flowId = asString(metadata.flowId ?? metadata.flow_id ?? metadata.requestId ?? metadata.request_id, "runtime-flow");
  const requestId = asString(metadata.requestId ?? metadata.request_id ?? taskId, taskId);
  const scope = buildWorkflowScope(metadata);
  const observeMode = inferObserveMode(metadata);
  const route = observeMode || asBoolean(metadata.requiresDelegation) ? "delegate" : "reply";
  const role = observeMode
    ? "observer_probe"
    : asBoolean(metadata.requiresDelegation)
      ? "worker_research"
      : "main_reply";

  return {
    authority: "native_taskflow",
    pluginName: "openclaw-native",
    workflow: {
      identity: {
        requestId,
        taskId,
        flowId,
        route,
        authority: "runtime_orchestrator",
        backend: "openclaw-native",
        materializationIntent: route === "delegate" ? "spawn_single" : "reply_direct",
      },
      lifecycle: {
        phase: route === "delegate" && !observeMode ? "checkpoint_pending" : "completed",
        deliveryState: "not_started",
        checkpointState: route === "delegate" ? "checkpoint_emitted" : "none",
      },
      execution: {
        role,
        modelProfile: route === "delegate" ? "worker_research" : "direct_main",
      },
      scope,
      reconcileOrRecovery: "native_host_authoritative",
    },
    binding: {
      taskId,
      flowId,
      status: route === "delegate" ? "running" : "completed",
      runtime: "openclaw-native",
      syncMode: "managed",
      substrateState: route === "delegate" ? "running" : "completed",
      substrateRevision: 0,
    },
    recovery: {
      required: false,
      trigger: "native_host_authoritative",
      timedOut: false,
      deadlineField: "",
      reason: "native_runtime_truth_is_authoritative",
      checkedAt: new Date().toISOString(),
      status: "not_applicable",
    },
  };
}

export function checkActiveTaskRecovery(options: { taskId?: string; now?: Date } = {}): {
  checkedAt: string;
  updatedCount: number;
  timedOutCount: number;
  recoveries: UnknownRecord[];
} {
  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    updatedCount: 0,
    timedOutCount: 0,
    recoveries: [],
  };
}

export function runtimeTruthDelegateContext(runtimeTruth: UnknownRecord): UnknownRecord | undefined {
  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  return buildDelegateTaskContext(delegateTask, delegateAttempt);
}
