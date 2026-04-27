import { createDetachedTaskLifecycleRuntime, type DetachedTaskExecutorCore, type DetachedTaskRegistryCore, type DetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { createOpenClawDistTaskFlowPort } from "../ports/openclaw-dist-taskflow-port.js";
import { loadOpenClawDistModule } from "./taskflow-bridge.js";

type JsonRecord = Record<string, unknown>;

type ExportAliasMap = Record<string, string[]>;

const TASK_EXECUTOR_ALIASES: ExportAliasMap = {
  createQueuedTaskRun: ["a"],
  createRunningTaskRun: ["o"],
  startTaskRunByRunId: ["f"],
  recordTaskRunProgressByRunId: ["l"],
  completeTaskRunByRunId: ["i"],
  failTaskRunByRunId: ["s"],
  setDetachedTaskDeliveryStatusByRunId: ["d"],
};

const TASK_REGISTRY_ALIASES: ExportAliasMap = {
  getTaskById: ["o"],
  markTaskTerminalById: ["_"],
  maybeDeliverTaskTerminalUpdate: ["y"],
};

function resolveExport(
  moduleValue: JsonRecord,
  canonicalName: string,
  aliases: string[],
): unknown {
  if (typeof moduleValue[canonicalName] === "function") {
    return moduleValue[canonicalName];
  }
  for (const alias of aliases) {
    if (typeof moduleValue[alias] === "function") {
      return moduleValue[alias];
    }
  }
  return undefined;
}

function requireFunctionWithAliases<T extends (...args: never[]) => unknown>(
  moduleValue: JsonRecord,
  name: string,
  aliases: string[],
): T {
  const fn = resolveExport(moduleValue, name, aliases);
  if (typeof fn !== "function") {
    const tried = [name, ...aliases].join(", ");
    throw new Error(`OpenClaw detached runtime integration missing export ${name} (tried: ${tried})`);
  }
  return fn as T;
}

async function loadDetachedRuntimeModules(): Promise<{
  taskExecutor: DetachedTaskExecutorCore;
  taskRegistry: DetachedTaskRegistryCore;
}> {
  const taskExecutorModule = await loadOpenClawDistModule("tasks/task-executor.js");
  const taskRegistryModule = await loadOpenClawDistModule("tasks/task-registry.js");

  return {
    taskExecutor: {
      createQueuedTaskRun: requireFunctionWithAliases(
        taskExecutorModule,
        "createQueuedTaskRun",
        TASK_EXECUTOR_ALIASES.createQueuedTaskRun,
      ),
      createRunningTaskRun: requireFunctionWithAliases(
        taskExecutorModule,
        "createRunningTaskRun",
        TASK_EXECUTOR_ALIASES.createRunningTaskRun,
      ),
      startTaskRunByRunId: requireFunctionWithAliases(
        taskExecutorModule,
        "startTaskRunByRunId",
        TASK_EXECUTOR_ALIASES.startTaskRunByRunId,
      ),
      recordTaskRunProgressByRunId: requireFunctionWithAliases(
        taskExecutorModule,
        "recordTaskRunProgressByRunId",
        TASK_EXECUTOR_ALIASES.recordTaskRunProgressByRunId,
      ),
      completeTaskRunByRunId: requireFunctionWithAliases(
        taskExecutorModule,
        "completeTaskRunByRunId",
        TASK_EXECUTOR_ALIASES.completeTaskRunByRunId,
      ),
      failTaskRunByRunId: requireFunctionWithAliases(
        taskExecutorModule,
        "failTaskRunByRunId",
        TASK_EXECUTOR_ALIASES.failTaskRunByRunId,
      ),
      setDetachedTaskDeliveryStatusByRunId: requireFunctionWithAliases(
        taskExecutorModule,
        "setDetachedTaskDeliveryStatusByRunId",
        TASK_EXECUTOR_ALIASES.setDetachedTaskDeliveryStatusByRunId,
      ),
    },
    taskRegistry: {
      getTaskById: requireFunctionWithAliases(
        taskRegistryModule,
        "getTaskById",
        TASK_REGISTRY_ALIASES.getTaskById,
      ),
      markTaskTerminalById: requireFunctionWithAliases(
        taskRegistryModule,
        "markTaskTerminalById",
        TASK_REGISTRY_ALIASES.markTaskTerminalById,
      ),
      maybeDeliverTaskTerminalUpdate: requireFunctionWithAliases(
        taskRegistryModule,
        "maybeDeliverTaskTerminalUpdate",
        TASK_REGISTRY_ALIASES.maybeDeliverTaskTerminalUpdate,
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

export { resolveExport, requireFunctionWithAliases, TASK_EXECUTOR_ALIASES, TASK_REGISTRY_ALIASES };
