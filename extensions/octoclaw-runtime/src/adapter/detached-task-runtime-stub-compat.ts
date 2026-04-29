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

export { resolveExport, requireFunctionWithAliases, TASK_EXECUTOR_ALIASES, TASK_REGISTRY_ALIASES };
