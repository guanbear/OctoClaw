import { randomUUID } from "node:crypto";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";

export function createHostDetachedTaskLifecycleRuntime(): Promise<DetachedTaskLifecycleRuntime> {
  return Promise.resolve({
    createQueuedTaskRun: (params) => ({
      taskId: randomUUID(),
      requesterSessionKey: params.requesterSessionKey,
      parentFlowId: params.parentFlowId,
      status: "queued",
    }),
    createRunningTaskRun: (params) => ({
      taskId: randomUUID(),
      requesterSessionKey: params.requesterSessionKey,
      parentFlowId: params.parentFlowId,
      status: "running",
    }),
    startTaskRunByRunId: () => [],
    recordTaskRunProgressByRunId: () => [],
    completeTaskRunByRunId: () => [],
    failTaskRunByRunId: () => [],
    setDetachedTaskDeliveryStatusByRunId: () => [],
    cancelDetachedTaskRunById: async () => ({ found: false, cancelled: false }),
    tryRecoverTaskBeforeMarkLost: async () => ({ recovered: false }),
  });
}
