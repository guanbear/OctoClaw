import fsSync from "node:fs";
import { resolveTaskStatePath } from "../resolve/env.js";
import { asBooleanStrict, asString, isRecord, type UnknownRecord } from "../util/type-coercion.js";
import { emitExecutionTransitionNotification } from "./execution-transition-notifier.js";
import { reduceCanonicalStatus, type LifecycleReconcileInput } from "../runtime-ledger/lifecycle-reconciler.js";
import type { NativeLifecycleStatus } from "../runtime-ledger/lifecycle-reconciler.js";
import { writeRebuiltTaskState } from "../runtime-ledger/projection-rebuild.js";

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

interface AckLogger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

interface TaskStateTask extends UnknownRecord {
  id?: unknown;
  status?: unknown;
  updated_at?: unknown;
  spawned_at?: unknown;
}

interface TaskStateFile extends UnknownRecord {
  tasks?: unknown;
}

interface NativeTaskState {
  sessionKey: string;
  flowId: string;
  found: boolean;
  currentState: string;
}

const fsSyncLike = fsSync as unknown as FsSyncLike;

export const WATCHDOG_INTERVAL_MS = 30_000;
export const WATCHDOG_DEBOUNCE_MS = 25_000;
export const STALE_QUEUED_THRESHOLD_MIN = 90;
export const STUCK_THRESHOLD_MIN = 15;

let watchdogLastTick = 0;

async function readTaskStateFile(): Promise<TaskStateFile> {
  try {
    const fs = await import("node:fs");
    const content = fs.default.readFileSync(resolveTaskStatePath(), "utf-8");
    return JSON.parse(content) as TaskStateFile;
  } catch {
    return {};
  }
}

function parseUpdatedSortValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = asString(value);
  if (!text) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function buildMinimalProjectionFromTaskState(
  task: TaskStateTask,
  status: string,
): import("@octoclaw/contracts/status-projection").TaskStatusProjection {
  const t = task as UnknownRecord;
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `exec_transition_${asString(t.id)}_${Date.now()}`,
    generatedAt,
    requestId: "",
    flowId: asString(t.flow_id),
    taskId: asString(t.id),
    title: "",
    summary: "",
    taskSummary: "",
    route: "delegate" as const,
    role: "",
    backend: "octoclaw.delegate",
    modelProfile: "",
    status: status as import("@octoclaw/contracts/status-projection").TaskProjectionStatus,
    success: false,
    createdAt: asString(t.created_at) || asString(t.spawned_at) || generatedAt,
    dispatchExecuted: asBooleanStrict(t.dispatchExecuted) || asBooleanStrict(t.dispatch_executed),
    spawnExecuted: asBooleanStrict(t.spawnExecuted) || asBooleanStrict(t.spawn_executed),
    resultMaterialized: asBooleanStrict(t.resultMaterialized) || asBooleanStrict(t.result_materialized),
    latestAnomalyNotice: (isRecord(t.latestAnomalyNotice) ? t.latestAnomalyNotice : isRecord(t.latest_anomaly_notice) ? t.latest_anomaly_notice : undefined) as import("@octoclaw/contracts/work-contract").AnomalyNotice | undefined,
    elapsedMs: 0,
    artifactRefs: [],
    artifactRefIds: [],
    actions: [],
  };
}

async function watchdogTransitionStaleTask(taskId: string, task: TaskStateTask, newStatus: string, sink: AckLogger): Promise<boolean> {
  try {
    const nativeState = await readNativeTaskState(taskId, task, sink);
    if (!nativeState.sessionKey || !nativeState.flowId) {
      sink.debug?.(`octoclaw watchdog: skip transition task=${taskId} missing session_key or flow_id`);
      return false;
    }
    if (!nativeState.found) {
      sink.debug?.(`octoclaw watchdog: skip transition task=${taskId} not found in runtime`);
      return false;
    }
    const { invokeNativeHelper } = await import("../adapter/native-helper.js");
    const currentState = nativeState.currentState;
    if (currentState === "completed" || currentState === "failed" || currentState === "timed_out") {
      return false;
    }
    const failResult = invokeNativeHelper({
      action: "fail-flow" as const,
      args: {
        session_key: nativeState.sessionKey,
        flow_id: nativeState.flowId,
        blocked_task_id: taskId,
        blocked_summary: `watchdog timeout: task ${taskId} stuck in ${currentState} after threshold`,
      },
    }) as unknown as { ok?: boolean; status?: string };
    if (failResult.ok) {
      sink.debug?.(`octoclaw watchdog: transitioned task=${taskId} to ${newStatus}`);
      updateTaskStateCache(taskId, {
        status: newStatus,
        updated_at: new Date().toISOString(),
        latestAnomalyNotice: {
          kind: "watchdog_timeout",
          severity: "error",
          taskId,
          message: `Watchdog transitioned task to ${newStatus}`,
          createdAt: new Date().toISOString(),
          nativeTaskId: asString((task as UnknownRecord).native_task_id),
          nativeFlowId: asString((task as UnknownRecord).flow_id),
        },
      });
      try {
        void emitExecutionTransitionNotification({
          transitionKind: "timed_out",
          projection: buildMinimalProjectionFromTaskState(task, newStatus),
          attemptId: taskId,
          workContractId: "",
          sessionKey: nativeState.sessionKey,
          stateKey: nativeState.sessionKey,
        });
      } catch (_) {}
      return true;
    }
    sink.debug?.(`octoclaw watchdog: failed to transition task=${taskId}: ${asString(failResult.status)}`);
    return false;
  } catch (err) {
    sink.debug?.(`octoclaw watchdog: error transitioning task=${taskId}: ${String(err)}`);
    return false;
  }
}

async function readNativeTaskState(taskId: string, task: TaskStateTask, sink: AckLogger): Promise<NativeTaskState> {
  const sessionKey = asString((task as UnknownRecord).session_key);
  const flowId = asString((task as UnknownRecord).flow_id);
  if (!sessionKey || !flowId) return { sessionKey, flowId, found: false, currentState: "" };
  try {
    const { invokeNativeHelper } = await import("../adapter/native-helper.js");
    const result = invokeNativeHelper({ action: "read-task", args: { session_key: sessionKey, flow_id: flowId, task_id: taskId } });
    if (!result?.found) return { sessionKey, flowId, found: false, currentState: "" };
    const taskRead = result as unknown as { task?: { state?: string; status?: string } };
    return {
      sessionKey,
      flowId,
      found: true,
      currentState: asString(taskRead.task?.state || taskRead.task?.status).toLowerCase(),
    };
  } catch (err) {
    sink.debug?.(`octoclaw watchdog: native read failed task=${taskId}: ${String(err)}`);
    return { sessionKey, flowId, found: false, currentState: "" };
  }
}

function nativeLifecycleStatus(state: NativeTaskState): NativeLifecycleStatus {
  if (!state.found) return "missing";
  if (["completed", "done", "succeeded", "success"].includes(state.currentState)) return "completed";
  if (["failed", "error", "errored"].includes(state.currentState)) return "failed";
  if (["timed_out", "timeout", "expired"].includes(state.currentState)) return "timed_out";
  if (["running", "in_progress", "active", "executing", "started", "dispatched"].includes(state.currentState)) return "running";
  return "missing";
}

function updateTaskStateCache(taskId: string, patch: Record<string, unknown>): void {
  try {
    const taskPath = resolveTaskStatePath();
    let existing: { tasks?: unknown[] } = { tasks: [] };
    try {
      existing = JSON.parse(fsSyncLike.readFileSync(taskPath, "utf-8")) as { tasks?: unknown[] };
    } catch { /* no file */ }
    const tasks = Array.isArray(existing.tasks) ? existing.tasks as TaskStateTask[] : [];
    const idx = tasks.findIndex((t) => asString(t.id) === taskId);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...patch };
      fsSyncLike.writeFileSync(taskPath, JSON.stringify({ tasks }, null, 2), "utf-8");
    }
  } catch { /* best effort */ }
}

export async function watchdogTick(logger: unknown): Promise<void> {
  const sink = isRecord(logger) ? logger as AckLogger : {};
  const now = Date.now();
  if (now - watchdogLastTick < WATCHDOG_DEBOUNCE_MS) {
    return;
  }
  watchdogLastTick = now;

  try {
    const taskState = await readTaskStateFile();
    const tasks = Array.isArray(taskState.tasks) ? taskState.tasks as TaskStateTask[] : [];
    if (tasks.length === 0) {
      return;
    }

    let staleCount = 0;
    let stuckCount = 0;
    let transitionedCount = 0;
    for (const task of tasks) {
      const taskId = asString(task.id);
      const status = asString(task.status).toLowerCase();
      const updatedAt = parseUpdatedSortValue(task.updated_at ?? task.spawned_at ?? 0);
      if (!taskId || !updatedAt) {
        continue;
      }
      const ageMin = (now - updatedAt) / 60_000;
      if (status === "queued" && ageMin > STALE_QUEUED_THRESHOLD_MIN) {
        staleCount += 1;
        sink.debug?.(`octoclaw watchdog: task_timeout task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
        try {
          const sessionKey = asString((task as UnknownRecord).session_key);
          updateTaskStateCache(taskId, {
            latestAnomalyNotice: {
              kind: "queued_stale",
              severity: "warning",
              taskId,
              message: `Task queued for ${ageMin.toFixed(0)} minutes exceeds ${STALE_QUEUED_THRESHOLD_MIN} minute threshold`,
              createdAt: new Date().toISOString(),
            },
          });
          void emitExecutionTransitionNotification({
            transitionKind: "queued_stale",
            projection: buildMinimalProjectionFromTaskState(task, "queued"),
            attemptId: taskId,
            workContractId: "",
            sessionKey,
            stateKey: sessionKey,
          });
        } catch (_) {}
        const transitioned = await watchdogTransitionStaleTask(taskId, task, "timed_out", sink);
        if (transitioned) transitionedCount += 1;
        continue;
      }
      if ((status === "running" || status === "dispatched") && ageMin > STUCK_THRESHOLD_MIN) {
        stuckCount += 1;
        const nativeState = await readNativeTaskState(taskId, task, sink);
        const expectedDeadline = new Date(updatedAt + STUCK_THRESHOLD_MIN * 60_000).toISOString();
        const hardDeadline = new Date(updatedAt + STALE_QUEUED_THRESHOLD_MIN * 60_000).toISOString();
        const reconcilerInput: LifecycleReconcileInput = {
          currentStatus: status,
          nativeStatus: nativeLifecycleStatus(nativeState),
          hasCompletionReceipt: false,
          hasArtifactRef: false,
          hasReportPath: false,
          hasResultSummary: false,
          hasDeliveryAck: false,
          expectedAt: expectedDeadline,
          hardTimeoutAt: hardDeadline,
          lastHeartbeatAt: null,
          lastProgressAt: null,
          now: new Date().toISOString(),
        };
        const reconcileResult = reduceCanonicalStatus(reconcilerInput);
        const watchdogStatus = reconcileResult.status;
        sink.debug?.(`octoclaw watchdog: runner_stuck task=${taskId} status=${status} native=${nativeState.currentState || "missing"} age_min=${ageMin.toFixed(1)} reducer=${watchdogStatus}`);
        try {
          const sessionKey = asString((task as UnknownRecord).session_key);
          updateTaskStateCache(taskId, {
            latestAnomalyNotice: {
              kind: "heartbeat_stale",
              severity: watchdogStatus === "timed_out" ? "error" : "warning",
              taskId,
              message: `Task ${status} for ${ageMin.toFixed(0)}min, reducer status: ${watchdogStatus} (${reconcileResult.reason})`,
              createdAt: new Date().toISOString(),
            },
          });
          void emitExecutionTransitionNotification({
            transitionKind: watchdogStatus === "timed_out" ? "timed_out" : "heartbeat_stale",
            projection: buildMinimalProjectionFromTaskState(task, watchdogStatus),
            attemptId: taskId,
            workContractId: "",
            sessionKey,
            stateKey: sessionKey,
          });
        } catch (_) {}
        if (watchdogStatus === "timed_out") {
          const transitioned = await watchdogTransitionStaleTask(taskId, task, "timed_out", sink);
          if (transitioned) transitionedCount += 1;
        }
      }
    }

    if (staleCount > 0 || stuckCount > 0 || transitionedCount > 0) {
      sink.debug?.(`octoclaw watchdog: stale_queued=${staleCount} stuck=${stuckCount} transitioned=${transitionedCount}`);
    }
  } catch (error) {
    sink.warn?.(`octoclaw watchdog tick failed: ${String(error)}`);
  }
}

export async function watchdogStartupReconcile(logger: unknown): Promise<void> {
  const sink = isRecord(logger) ? logger as AckLogger : {};
  try {
    writeRebuiltTaskState();
    watchdogLastTick = 0;
    await watchdogTick(logger);
  } catch (error) {
    sink.warn?.(`octoclaw watchdog startup reconcile failed: ${String(error)}`);
  }
}
