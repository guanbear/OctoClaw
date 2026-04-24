import { createDetachedTaskLifecycleRuntime, type DetachedTaskExecutorCore, type DetachedTaskRegistryCore, type DetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { createOpenClawDistTaskFlowPort } from "../ports/openclaw-dist-taskflow-port.js";
import { loadOpenClawDistModule } from "./taskflow-bridge.js";

type JsonRecord = Record<string, unknown>;

function requireFunction<T extends (...args: never[]) => unknown>(
  moduleValue: JsonRecord,
  name: string,
): T {
  const candidate = moduleValue[name];
  if (typeof candidate !== "function") {
    throw new Error(`OpenClaw detached runtime integration missing export ${name}`);
  }
  return candidate as T;
}

async function loadDetachedRuntimeModules(): Promise<{
  taskExecutor: DetachedTaskExecutorCore;
  taskRegistry: DetachedTaskRegistryCore;
}> {
  const taskExecutorModule = await loadOpenClawDistModule("tasks/task-executor.js");
  const taskRegistryModule = await loadOpenClawDistModule("tasks/task-registry.js");

  return {
    taskExecutor: {
      createQueuedTaskRun: requireFunction(taskExecutorModule, "createQueuedTaskRun"),
      createRunningTaskRun: requireFunction(taskExecutorModule, "createRunningTaskRun"),
      startTaskRunByRunId: requireFunction(taskExecutorModule, "startTaskRunByRunId"),
      recordTaskRunProgressByRunId: requireFunction(
        taskExecutorModule,
        "recordTaskRunProgressByRunId",
      ),
      completeTaskRunByRunId: requireFunction(taskExecutorModule, "completeTaskRunByRunId"),
      failTaskRunByRunId: requireFunction(taskExecutorModule, "failTaskRunByRunId"),
      setDetachedTaskDeliveryStatusByRunId: requireFunction(
        taskExecutorModule,
        "setDetachedTaskDeliveryStatusByRunId",
      ),
    },
    taskRegistry: {
      getTaskById: requireFunction(taskRegistryModule, "getTaskById"),
      markTaskTerminalById: requireFunction(taskRegistryModule, "markTaskTerminalById"),
      maybeDeliverTaskTerminalUpdate: requireFunction(
        taskRegistryModule,
        "maybeDeliverTaskTerminalUpdate",
      ),
    },
  };
}

let detachedRuntimePromise: Promise<DetachedTaskLifecycleRuntime> | null = null;

export function createHostDetachedTaskLifecycleRuntime(): Promise<DetachedTaskLifecycleRuntime> {
  detachedRuntimePromise ??= loadDetachedRuntimeModules().then(({ taskExecutor, taskRegistry }) =>
    createDetachedTaskLifecycleRuntime({
      taskExecutor,
      taskRegistry,
      taskFlowPortFactory: async () => createOpenClawDistTaskFlowPort(),
    }),
  );
  return detachedRuntimePromise;
}
