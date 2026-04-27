import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDetachedTaskLifecycleRuntime, type DetachedRunningTaskCreateParams, type DetachedTaskCancelParams, type DetachedTaskCompleteParams, type DetachedTaskCreateParams, type DetachedTaskDeliveryStatusParams, type DetachedTaskFailParams, type DetachedTaskProgressParams, type DetachedTaskRecord, type DetachedTaskRegistryCore, type DetachedTaskStartParams } from "./detached-task-runtime.js";
import { resolveExport, requireFunctionWithAliases, TASK_EXECUTOR_ALIASES, TASK_REGISTRY_ALIASES } from "./detached-task-runtime-host.js";
import { loadOpenClawDistModule } from "./taskflow-bridge.js";
import type { BoundTaskFlowPort, TaskFlowPort } from "../ports/taskflow-port.js";

const fs = fsSync as unknown as {
  chmodSync(pathname: string, mode: number): void;
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  mkdtempSync(pathname: string): string;
  writeFileSync(pathname: string, data: string): void;
};
const osModule = os as unknown as { tmpdir(): string };

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

describe("hashed dist export alias resolution", () => {
  it("loads hashed task executor dist bundle when exact legacy path is absent", async () => {
    const root = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-openclaw-dist-"));
    const binDir = path.join(root, "bin");
    const distDir = path.join(root, "dist");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "test" }));
    const openclawBin = path.join(binDir, "openclaw");
    fs.writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(openclawBin, 0o755);
    fs.mkdirSync(path.join(distDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "task-executor-TestHash.js"),
      [
        "function createQueuedTaskRun() { return 'queued'; }",
        "function createRunningTaskRun() { return 'running'; }",
        "function startTaskRunByRunId() { return 'started'; }",
        "export { createQueuedTaskRun as a, createRunningTaskRun as o, startTaskRunByRunId as f };",
      ].join("\n"),
    );

    const mod = await loadOpenClawDistModule("tasks/task-executor.js", openclawBin);

    expect(typeof mod.a).toBe("function");
    expect((mod.a as () => string)()).toBe("queued");
  });

  it("resolves canonical export name when present", () => {
    const mod = { createQueuedTaskRun: () => "canonical" };
    const fn = resolveExport(mod, "createQueuedTaskRun", TASK_EXECUTOR_ALIASES.createQueuedTaskRun);
    expect(typeof fn).toBe("function");
    expect((fn as () => string)()).toBe("canonical");
  });

  it("resolves aliased export when canonical name is absent", () => {
    const mod = { a: () => "aliased" };
    const fn = resolveExport(mod, "createQueuedTaskRun", TASK_EXECUTOR_ALIASES.createQueuedTaskRun);
    expect(typeof fn).toBe("function");
    expect((fn as () => string)()).toBe("aliased");
  });

  it("prefers canonical name over alias when both exist", () => {
    const mod = { createQueuedTaskRun: () => "canonical", a: () => "aliased" };
    const fn = resolveExport(mod, "createQueuedTaskRun", TASK_EXECUTOR_ALIASES.createQueuedTaskRun);
    expect((fn as () => string)()).toBe("canonical");
  });

  it("returns undefined when neither canonical nor alias exists", () => {
    const mod = { irrelevant: () => "nope" };
    const fn = resolveExport(mod, "createQueuedTaskRun", TASK_EXECUTOR_ALIASES.createQueuedTaskRun);
    expect(fn).toBeUndefined();
  });

  it("requireFunctionWithAliases throws with tried names when missing", () => {
    const mod = { irrelevant: true };
    expect(() => requireFunctionWithAliases(mod, "createQueuedTaskRun", TASK_EXECUTOR_ALIASES.createQueuedTaskRun)).toThrow(
      "tried: createQueuedTaskRun, a",
    );
  });

  it("requireFunctionWithAliases returns function when canonical exists", () => {
    const fn = () => "ok";
    const mod = { startTaskRunByRunId: fn };
    expect(requireFunctionWithAliases(mod, "startTaskRunByRunId", TASK_EXECUTOR_ALIASES.startTaskRunByRunId)).toBe(fn);
  });

  it("requireFunctionWithAliases returns function when only alias exists", () => {
    const fn = () => "ok";
    const mod = { f: fn };
    expect(requireFunctionWithAliases(mod, "startTaskRunByRunId", TASK_EXECUTOR_ALIASES.startTaskRunByRunId)).toBe(fn);
  });

  it("resolves all task executor aliases from minified module", () => {
    const mod = {
      a: () => {},
      o: () => {},
      f: () => {},
      l: () => {},
      i: () => {},
      s: () => {},
      d: () => {},
    };
    for (const [canonical, aliases] of Object.entries(TASK_EXECUTOR_ALIASES)) {
      expect(typeof resolveExport(mod, canonical, aliases)).toBe("function");
    }
  });

  it("resolves all task registry aliases from minified module", () => {
    const mod = {
      o: () => {},
      _: () => {},
      y: () => {},
    };
    for (const [canonical, aliases] of Object.entries(TASK_REGISTRY_ALIASES)) {
      expect(typeof resolveExport(mod, canonical, aliases)).toBe("function");
    }
  });
});
