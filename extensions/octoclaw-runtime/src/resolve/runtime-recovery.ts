import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { DelegateAttempt, DelegateTask } from "@octoclaw/contracts/delegate";
import { inferObserveMode, isDelegateAttempt, isDelegateTask, normalizeWorkspaceMode } from "./policy-routing-helpers.js";
import { type UnknownRecord, asRecord, asString, asBoolean } from "../util/type-coercion.js";
import type { DeliveryOutbox, DeliveryOutboxItem } from "./delivery-outbox.js";

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

export interface RecoveryTaskRun extends UnknownRecord {
  task_id?: unknown;
  taskId?: unknown;
  run_id?: unknown;
  runId?: unknown;
  status?: unknown;
  delivery_status?: unknown;
  deliveryStatus?: unknown;
  error?: unknown;
}

export interface ActiveTaskRecoveryOptions {
  taskId?: string;
  now?: Date;
  taskRuns?: RecoveryTaskRun[];
  outbox?: DeliveryOutbox;
  deliverResult?: (item: DeliveryOutboxItem, run: RecoveryTaskRun) => boolean;
}

export function checkActiveTaskRecovery(options: ActiveTaskRecoveryOptions = {}): {
  checkedAt: string;
  updatedCount: number;
  timedOutCount: number;
  recoveries: UnknownRecord[];
} {
  const checkedAt = (options.now ?? new Date()).toISOString();
  const taskRuns = Array.isArray(options.taskRuns) ? options.taskRuns : [];
  const outbox = options.outbox;
  if (!outbox || taskRuns.length === 0) {
    return {
      checkedAt,
      updatedCount: 0,
      timedOutCount: 0,
      recoveries: [],
    };
  }

  let updatedCount = 0;
  const recoveries: UnknownRecord[] = [];
  const outboxItems = outbox.list();

  for (const run of taskRuns) {
    const taskId = taskRunTaskId(run);
    if (options.taskId && taskId !== options.taskId) continue;
    const runId = taskRunRunId(run);
    const status = asString(run.status).toLowerCase();
    const deliveryStatus = asString(run.deliveryStatus ?? run.delivery_status).toLowerCase();
    const matchingOutbox = outboxItems.find((item) => item.taskId === taskId || (runId && item.runId === runId));

    if (matchingOutbox && (matchingOutbox.status === "delivered" || matchingOutbox.status === "interrupted")) {
      continue;
    }

    if (status === "succeeded" && deliveryStatus === "pending" && matchingOutbox?.status === "pending") {
      const delivered = options.deliverResult?.(matchingOutbox, run) === true;
      if (!delivered) continue;
      outbox.markDelivered(matchingOutbox.outboxId, checkedAt);
      updatedCount += 1;
      recoveries.push({
        action: "deliver_result",
        taskId,
        runId,
        outboxId: matchingOutbox.outboxId,
        resultHash: matchingOutbox.resultHash,
        reason: "completed_pending_delivery",
      });
      continue;
    }

    const restartReason = restartInterruptionReason(run);
    if (restartReason && !matchingOutbox) {
      updatedCount += 1;
      recoveries.push({
        action: "interrupted_by_restart",
        taskId,
        runId,
        reason: restartReason,
      });
    }
  }

  return {
    checkedAt,
    updatedCount,
    timedOutCount: 0,
    recoveries,
  };
}

function taskRunTaskId(run: RecoveryTaskRun): string {
  return asString(run.taskId ?? run.task_id);
}

function taskRunRunId(run: RecoveryTaskRun): string {
  return asString(run.runId ?? run.run_id);
}

function restartInterruptionReason(run: RecoveryTaskRun): string {
  const status = asString(run.status).toLowerCase();
  if (!["failed", "lost"].includes(status)) return "";
  const error = asString(run.error).toLowerCase();
  if (/service restart|gateway closed|abnormal closure|draining for restart/.test(error)) return "gateway_restart";
  if (/backing session missing|missing-session-entry|orphan/.test(error)) return "missing_session_after_restart";
  return "";
}

export function runtimeTruthDelegateContext(runtimeTruth: UnknownRecord): UnknownRecord | undefined {
  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  return buildDelegateTaskContext(delegateTask, delegateAttempt);
}
