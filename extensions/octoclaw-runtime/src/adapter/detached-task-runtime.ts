import type { TaskFlowPort } from "../ports/taskflow-port.js";

type JsonRecord = Record<string, unknown>;

export interface DetachedTaskRecord {
  taskId: string;
  requesterSessionKey?: string;
  parentFlowId?: string;
  status?: string;
  error?: string;
  progressSummary?: string;
}

export interface DetachedTaskCreateParams {
  runtime: string;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: string;
  requesterOrigin?: JsonRecord;
  parentFlowId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: string;
  deliveryStatus?: string;
}

export interface DetachedRunningTaskCreateParams extends DetachedTaskCreateParams {
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}

export interface DetachedTaskStartParams {
  runId: string;
  runtime?: string;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}

export interface DetachedTaskProgressParams {
  runId: string;
  runtime?: string;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}

export interface DetachedTaskCompleteParams {
  runId: string;
  runtime?: string;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: string | null;
}

export interface DetachedTaskFailParams {
  runId: string;
  runtime?: string;
  sessionKey?: string;
  status?: "failed" | "timed_out" | "cancelled";
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
}

export interface DetachedTaskDeliveryStatusParams {
  runId: string;
  runtime?: string;
  sessionKey?: string;
  deliveryStatus: string;
}

export interface DetachedTaskCancelParams {
  cfg: unknown;
  taskId: string;
}

export interface DetachedTaskCancelResult {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: DetachedTaskRecord;
}

export interface DetachedTaskRecoveryAttemptParams {
  taskId: string;
  runtime: string;
  task: DetachedTaskRecord;
  now: number;
}

export interface DetachedTaskRecoveryAttemptResult {
  recovered: boolean;
}

export interface DetachedTaskLifecycleRuntime {
  createQueuedTaskRun: (params: DetachedTaskCreateParams) => DetachedTaskRecord;
  createRunningTaskRun: (params: DetachedRunningTaskCreateParams) => DetachedTaskRecord;
  startTaskRunByRunId: (params: DetachedTaskStartParams) => DetachedTaskRecord[];
  recordTaskRunProgressByRunId: (params: DetachedTaskProgressParams) => DetachedTaskRecord[];
  completeTaskRunByRunId: (params: DetachedTaskCompleteParams) => DetachedTaskRecord[];
  failTaskRunByRunId: (params: DetachedTaskFailParams) => DetachedTaskRecord[];
  setDetachedTaskDeliveryStatusByRunId: (params: DetachedTaskDeliveryStatusParams) => DetachedTaskRecord[];
  cancelDetachedTaskRunById: (
    params: DetachedTaskCancelParams,
  ) => Promise<DetachedTaskCancelResult>;
  tryRecoverTaskBeforeMarkLost?: (
    params: DetachedTaskRecoveryAttemptParams,
  ) => DetachedTaskRecoveryAttemptResult | Promise<DetachedTaskRecoveryAttemptResult>;
}

export interface DetachedTaskExecutorCore {
  createQueuedTaskRun: (params: DetachedTaskCreateParams) => DetachedTaskRecord;
  createRunningTaskRun: (params: DetachedRunningTaskCreateParams) => DetachedTaskRecord;
  startTaskRunByRunId: (params: DetachedTaskStartParams) => DetachedTaskRecord[];
  recordTaskRunProgressByRunId: (params: DetachedTaskProgressParams) => DetachedTaskRecord[];
  completeTaskRunByRunId: (params: DetachedTaskCompleteParams) => DetachedTaskRecord[];
  failTaskRunByRunId: (params: DetachedTaskFailParams) => DetachedTaskRecord[];
  setDetachedTaskDeliveryStatusByRunId: (
    params: DetachedTaskDeliveryStatusParams,
  ) => DetachedTaskRecord[];
}

export interface DetachedTaskRegistryCore {
  getTaskById: (taskId: string) => DetachedTaskRecord | null | undefined;
  markTaskTerminalById: (params: {
    taskId: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    terminalSummary?: string | null;
    terminalOutcome?: string | null;
  }) => DetachedTaskRecord | null;
  maybeDeliverTaskTerminalUpdate?: (taskId: string) => unknown;
}

export interface CreateDetachedTaskLifecycleRuntimeOptions {
  taskExecutor: DetachedTaskExecutorCore;
  taskRegistry: DetachedTaskRegistryCore;
  taskFlowPortFactory: () => Promise<TaskFlowPort>;
  now?: () => number;
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function isTerminalSubstrateState(value: unknown): boolean {
  const normalized = stringValue(value).toLowerCase();
  return normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "failed"
    || normalized === "succeeded"
    || normalized === "completed"
    || normalized === "timed_out"
    || normalized === "timed-out"
    || normalized === "lost";
}

function resolveTaskFlowError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown detached runtime error");
}

async function markCancelledTask(params: {
  taskId: string;
  now: number;
  taskRegistry: DetachedTaskRegistryCore;
}): Promise<DetachedTaskRecord | undefined> {
  const updated = params.taskRegistry.markTaskTerminalById({
    taskId: params.taskId,
    status: "cancelled",
    endedAt: params.now,
    lastEventAt: params.now,
    error: "Cancelled by operator.",
  }) ?? params.taskRegistry.getTaskById(params.taskId) ?? undefined;
  try {
    await Promise.resolve(params.taskRegistry.maybeDeliverTaskTerminalUpdate?.(params.taskId));
  } catch {
    // Delivery failures should not roll back task cancellation.
  }
  return updated ?? undefined;
}

export function createDetachedTaskLifecycleRuntime(
  options: CreateDetachedTaskLifecycleRuntimeOptions,
): DetachedTaskLifecycleRuntime {
  const now = options.now ?? (() => Date.now());

  return {
    createQueuedTaskRun: (params) => options.taskExecutor.createQueuedTaskRun(params),
    createRunningTaskRun: (params) => options.taskExecutor.createRunningTaskRun(params),
    startTaskRunByRunId: (params) => options.taskExecutor.startTaskRunByRunId(params),
    recordTaskRunProgressByRunId: (params) =>
      options.taskExecutor.recordTaskRunProgressByRunId(params),
    completeTaskRunByRunId: (params) => options.taskExecutor.completeTaskRunByRunId(params),
    failTaskRunByRunId: (params) => options.taskExecutor.failTaskRunByRunId(params),
    setDetachedTaskDeliveryStatusByRunId: (params) =>
      options.taskExecutor.setDetachedTaskDeliveryStatusByRunId(params),
    cancelDetachedTaskRunById: async (params) => {
      const taskId = stringValue(params.taskId);
      const task = options.taskRegistry.getTaskById(taskId);
      const sessionKey = stringValue(task?.requesterSessionKey);
      const flowId = stringValue(task?.parentFlowId);
      if (!task || !sessionKey || !flowId) {
        return {
          found: false,
          cancelled: false,
        };
      }

      let taskFlowPort: TaskFlowPort;
      try {
        taskFlowPort = await options.taskFlowPortFactory();
      } catch {
        return {
          found: false,
          cancelled: false,
        };
      }

      try {
        const bound = taskFlowPort.bindSession({ sessionKey });
        const result = await bound.cancel({ flowId });
        const cancelled = result.cancelled === true;
        if (!cancelled) {
          if (result.found === false) {
            return {
              found: false,
              cancelled: false,
            };
          }
          return {
            found: true,
            cancelled: false,
            reason: stringValue(result.reason) || "TaskFlow owner declined cancellation.",
            task,
          };
        }

        const updated = await markCancelledTask({
          taskId,
          now: now(),
          taskRegistry: options.taskRegistry,
        });
        return {
          found: true,
          cancelled: true,
          task: updated,
        };
      } catch (error) {
        return {
          found: true,
          cancelled: false,
          reason: resolveTaskFlowError(error),
          task,
        };
      }
    },
    tryRecoverTaskBeforeMarkLost: async (params) => {
      const sessionKey = stringValue(params.task.requesterSessionKey);
      const flowId = stringValue(params.task.parentFlowId);
      const taskId = stringValue(params.task.taskId || params.taskId);
      if (!sessionKey || !flowId || !taskId) {
        return { recovered: false };
      }

      let taskFlowPort: TaskFlowPort;
      try {
        taskFlowPort = await options.taskFlowPortFactory();
      } catch {
        return { recovered: false };
      }

      try {
        const bound = taskFlowPort.bindSession({ sessionKey });
        const taskState = await bound.getTaskSummary(flowId);
        if (taskState?.taskId === taskId && !isTerminalSubstrateState(taskState.status || taskState.state)) {
          return { recovered: true };
        }

        const flowState = await bound.get(flowId);
        if (flowState && !isTerminalSubstrateState(flowState.status || flowState.state)) {
          return { recovered: true };
        }
      } catch {
        return { recovered: false };
      }

      return { recovered: false };
    },
  };
}
