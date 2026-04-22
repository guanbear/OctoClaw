import { describe, expect, it, vi } from "vitest";
import { createDetachedTaskLifecycleRuntime, type DetachedRunningTaskCreateParams, type DetachedTaskCancelParams, type DetachedTaskCompleteParams, type DetachedTaskCreateParams, type DetachedTaskDeliveryStatusParams, type DetachedTaskFailParams, type DetachedTaskProgressParams, type DetachedTaskRecord, type DetachedTaskRegistryCore, type DetachedTaskStartParams } from "./detached-task-runtime.js";
import type { TaskFlowBridge } from "./taskflow-bridge.js";

function createBridgeStub(overrides: Partial<TaskFlowBridge> = {}): TaskFlowBridge {
  return {
    createManagedFlow: () => ({ ok: true }),
    runTask: () => ({ ok: true }),
    readFlow: () => ({ ok: true, found: false, status: "not_found" }),
    readTask: () => ({ ok: true, found: false, status: "not_found" }),
    setWaiting: () => ({ ok: true }),
    finishFlow: () => ({ ok: true }),
    failFlow: () => ({ ok: true }),
    cancelFlow: () => ({ ok: false, found: false, cancelled: false, status: "not_found", reason: "" }),
    ...overrides,
  };
}

describe("detached task lifecycle runtime", () => {
  it("delegates lifecycle mutations to the core task executor", () => {
    const calls: string[] = [];
    const queuedTask: DetachedTaskRecord = { taskId: "task-queued" };
    const runningTask: DetachedTaskRecord = { taskId: "task-running" };
    const eventTasks: DetachedTaskRecord[] = [{ taskId: "task-event" }];
    const taskExecutor = {
      createQueuedTaskRun: (params: DetachedTaskCreateParams) => {
        calls.push(`queued:${params.task}`);
        return queuedTask;
      },
      createRunningTaskRun: (params: DetachedRunningTaskCreateParams) => {
        calls.push(`running:${params.task}`);
        return runningTask;
      },
      startTaskRunByRunId: (params: DetachedTaskStartParams) => {
        calls.push(`start:${params.runId}`);
        return eventTasks;
      },
      recordTaskRunProgressByRunId: (params: DetachedTaskProgressParams) => {
        calls.push(`progress:${params.runId}`);
        return eventTasks;
      },
      completeTaskRunByRunId: (params: DetachedTaskCompleteParams) => {
        calls.push(`complete:${params.runId}`);
        return eventTasks;
      },
      failTaskRunByRunId: (params: DetachedTaskFailParams) => {
        calls.push(`fail:${params.runId}`);
        return eventTasks;
      },
      setDetachedTaskDeliveryStatusByRunId: (params: DetachedTaskDeliveryStatusParams) => {
        calls.push(`delivery:${params.runId}`);
        return eventTasks;
      },
    };
    const taskRegistry: DetachedTaskRegistryCore = {
      getTaskById: () => null,
      markTaskTerminalById: () => null,
    };
    const runtime = createDetachedTaskLifecycleRuntime({
      taskExecutor,
      taskRegistry,
      bridgeFactory: async () => createBridgeStub(),
    });

    expect(runtime.createQueuedTaskRun({ runtime: "subagent", task: "queue" })).toBe(queuedTask);
    expect(runtime.createRunningTaskRun({ runtime: "subagent", task: "run" })).toBe(runningTask);
    expect(runtime.startTaskRunByRunId({ runId: "run-1" })).toBe(eventTasks);
    expect(runtime.recordTaskRunProgressByRunId({ runId: "run-1" })).toBe(eventTasks);
    expect(runtime.completeTaskRunByRunId({ runId: "run-1", endedAt: 1 })).toBe(eventTasks);
    expect(runtime.failTaskRunByRunId({ runId: "run-1", endedAt: 1 })).toBe(eventTasks);
    expect(runtime.setDetachedTaskDeliveryStatusByRunId({ runId: "run-1", deliveryStatus: "pending" })).toBe(eventTasks);
    expect(calls).toEqual([
      "queued:queue",
      "running:run",
      "start:run-1",
      "progress:run-1",
      "complete:run-1",
      "fail:run-1",
      "delivery:run-1",
    ]);
  });

  it("cancels flow-backed tasks through the taskflow owner and marks the task terminal", async () => {
    const maybeDeliver = vi.fn();
    const markTaskTerminalById = vi.fn(() => ({
      taskId: "task-owned",
      requesterSessionKey: "agent:main:main",
      parentFlowId: "flow-owned",
      status: "cancelled",
    }));
    const runtime = createDetachedTaskLifecycleRuntime({
      taskExecutor: {
        createQueuedTaskRun: () => ({ taskId: "unused" }),
        createRunningTaskRun: () => ({ taskId: "unused" }),
        startTaskRunByRunId: () => [],
        recordTaskRunProgressByRunId: () => [],
        completeTaskRunByRunId: () => [],
        failTaskRunByRunId: () => [],
        setDetachedTaskDeliveryStatusByRunId: () => [],
      },
      taskRegistry: {
        getTaskById: () => ({
          taskId: "task-owned",
          requesterSessionKey: "agent:main:main",
          parentFlowId: "flow-owned",
          status: "running",
        }),
        markTaskTerminalById,
        maybeDeliverTaskTerminalUpdate: maybeDeliver,
      },
      bridgeFactory: async () => createBridgeStub({
        cancelFlow: () => ({
          ok: true,
          found: true,
          cancelled: true,
          status: "cancelled",
          reason: "",
        }),
      }),
      now: () => 42,
    });

    const result = await runtime.cancelDetachedTaskRunById({
      cfg: {},
      taskId: "task-owned",
    } satisfies DetachedTaskCancelParams);

    expect(result).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        taskId: "task-owned",
        status: "cancelled",
      },
    });
    expect(markTaskTerminalById).toHaveBeenCalledWith({
      taskId: "task-owned",
      status: "cancelled",
      endedAt: 42,
      lastEventAt: 42,
      error: "Cancelled by operator.",
    });
    expect(maybeDeliver).toHaveBeenCalledWith("task-owned");
  });

  it("falls back to core cancellation when a task does not have flow ownership metadata", async () => {
    const runtime = createDetachedTaskLifecycleRuntime({
      taskExecutor: {
        createQueuedTaskRun: () => ({ taskId: "unused" }),
        createRunningTaskRun: () => ({ taskId: "unused" }),
        startTaskRunByRunId: () => [],
        recordTaskRunProgressByRunId: () => [],
        completeTaskRunByRunId: () => [],
        failTaskRunByRunId: () => [],
        setDetachedTaskDeliveryStatusByRunId: () => [],
      },
      taskRegistry: {
        getTaskById: () => ({
          taskId: "task-plain",
          requesterSessionKey: "agent:main:main",
          status: "running",
        }),
        markTaskTerminalById: () => null,
      },
      bridgeFactory: async () => createBridgeStub(),
    });

    await expect(runtime.cancelDetachedTaskRunById({ cfg: {}, taskId: "task-plain" })).resolves.toEqual({
      found: false,
      cancelled: false,
    });
  });

  it("treats live flow-backed tasks as recovered before lost marking", async () => {
    const runtime = createDetachedTaskLifecycleRuntime({
      taskExecutor: {
        createQueuedTaskRun: () => ({ taskId: "unused" }),
        createRunningTaskRun: () => ({ taskId: "unused" }),
        startTaskRunByRunId: () => [],
        recordTaskRunProgressByRunId: () => [],
        completeTaskRunByRunId: () => [],
        failTaskRunByRunId: () => [],
        setDetachedTaskDeliveryStatusByRunId: () => [],
      },
      taskRegistry: {
        getTaskById: () => null,
        markTaskTerminalById: () => null,
      },
      bridgeFactory: async () => createBridgeStub({
        readTask: () => ({
          ok: true,
          found: true,
          status: "running",
          flow: { flowId: "flow-live", status: "running", revision: 2 },
          task: { taskId: "task-live", status: "running", revision: 3 },
        }),
      }),
    });

    await expect(runtime.tryRecoverTaskBeforeMarkLost?.({
      taskId: "task-live",
      runtime: "subagent",
      now: 100,
      task: {
        taskId: "task-live",
        requesterSessionKey: "agent:main:main",
        parentFlowId: "flow-live",
        status: "running",
      },
    })).resolves.toEqual({ recovered: true });
  });
});
