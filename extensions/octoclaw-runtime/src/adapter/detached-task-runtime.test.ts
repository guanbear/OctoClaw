import { describe, expect, it, vi } from "vitest";
import { createDetachedTaskLifecycleRuntime, type DetachedRunningTaskCreateParams, type DetachedTaskCancelParams, type DetachedTaskCompleteParams, type DetachedTaskCreateParams, type DetachedTaskDeliveryStatusParams, type DetachedTaskFailParams, type DetachedTaskProgressParams, type DetachedTaskRecord, type DetachedTaskRegistryCore, type DetachedTaskStartParams } from "./detached-task-runtime.js";
import { createHostDetachedTaskLifecycleRuntime } from "./detached-task-runtime-host.js";
import type { BoundTaskFlowPort, TaskFlowPort } from "../ports/taskflow-port.js";


function createTaskFlowPortStub(overrides: Partial<BoundTaskFlowPort> = {}): TaskFlowPort {
  const bound: BoundTaskFlowPort = {
    createManaged: async () => ({ flowId: "flow-stub" }),
    runTask: async () => ({ created: true, flowId: "flow-stub", taskId: "task-stub" }),
    get: async () => null,
    resolve: async () => null,
    getTaskSummary: async () => null,
    setWaiting: async (input) => ({ applied: true, flowId: input.flowId, status: "ok" }),
    finish: async (input) => ({ applied: true, flowId: input.flowId, status: "ok" }),
    fail: async (input) => ({ applied: true, flowId: input.flowId, status: "ok" }),
    cancel: async (input) => ({ flowId: input.flowId, found: false, cancelled: false, reason: "" }),
    ...overrides,
  };
  return {
    bindSession: () => bound,
  };
}

describe("detached task lifecycle runtime", () => {
  it("creates a host stub runtime without loading OpenClaw internals", async () => {
    const runtime = await createHostDetachedTaskLifecycleRuntime();
    const queued = runtime.createQueuedTaskRun({
      runtime: "subagent",
      task: "queue safely",
      requesterSessionKey: "agent:main:main",
      parentFlowId: "flow-stub",
    });
    const running = runtime.createRunningTaskRun({
      runtime: "subagent",
      task: "run safely",
      requesterSessionKey: "agent:main:main",
      parentFlowId: "flow-stub",
    });

    expect(queued).toMatchObject({
      requesterSessionKey: "agent:main:main",
      parentFlowId: "flow-stub",
      status: "queued",
    });
    expect(running).toMatchObject({
      requesterSessionKey: "agent:main:main",
      parentFlowId: "flow-stub",
      status: "running",
    });
    expect(runtime.startTaskRunByRunId({ runId: "missing" })).toEqual([]);
    await expect(runtime.cancelDetachedTaskRunById({ cfg: {}, taskId: "missing" })).resolves.toEqual({ found: false, cancelled: false });
  });

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
      taskFlowPortFactory: async () => createTaskFlowPortStub(),
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
      taskFlowPortFactory: async () => createTaskFlowPortStub({
        cancel: async (input) => ({
          flowId: input.flowId,
          found: true,
          cancelled: true,
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
      taskFlowPortFactory: async () => createTaskFlowPortStub(),
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
      taskFlowPortFactory: async () => createTaskFlowPortStub({
        getTaskSummary: async () => ({
          taskId: "task-live",
          status: "running",
          revision: 3,
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
