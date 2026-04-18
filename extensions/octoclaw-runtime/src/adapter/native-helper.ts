declare const process: {
  getBuiltinModule?: (name: string) => unknown;
};

type SpawnSync = (
  command: string,
  args?: string[],
  options?: {
    cwd?: string;
    encoding?: string;
  },
) => {
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function resolveSpawnSync(): SpawnSync {
  const childProcessModule = process.getBuiltinModule?.("child_process") as { spawnSync?: SpawnSync } | undefined;
  if (!childProcessModule?.spawnSync) {
    throw new Error("native helper invocation failed: child_process builtin unavailable");
  }
  return childProcessModule.spawnSync;
}

const spawnSync = resolveSpawnSync();

export type NativeHelperAction = "create-managed-flow" | "run-task" | "cancel-flow" | "read-flow" | "read-task";

export interface NativeHelperInvokeArgs {
  action: NativeHelperAction;
  args: Record<string, string>;
}

export interface NativeManagedFlowHelperInvokeArgs {
  action: "create-managed-flow";
  args: Record<string, string>;
}

export interface NativeRunTaskHelperInvokeArgs {
  action: "run-task";
  args: Record<string, string>;
}

export interface NativeCancelFlowHelperInvokeArgs {
  action: "cancel-flow";
  args: Record<string, string>;
}

export interface NativeReadFlowHelperInvokeArgs {
  action: "read-flow";
  args: Record<string, string>;
}

export interface NativeReadTaskHelperInvokeArgs {
  action: "read-task";
  args: Record<string, string>;
}

export interface NativeManagedFlowHelperResult {
  ok: true;
  flow_id: string;
  flow: {
    flowId: string;
    status: string;
    revision: number;
  };
}

export interface NativeRunTaskHelperResult {
  ok: true;
  native_task_id: string;
  flow_id: string;
  task: {
    taskId: string;
    status: string;
    syncMode: "managed" | "mirrored";
    state: string;
    revision: number;
  };
}

export interface NativeCancelFlowHelperResult {
  ok: boolean;
  status: string;
  flow_id: string;
  found: boolean;
  cancelled: boolean;
  reason: string;
}

export interface NativeReadFlowHelperResult {
  ok: boolean;
  status: string;
  flow_id: string;
  found: boolean;
  flow: {
    flowId: string;
    status: string;
    revision: number;
    currentStep?: string;
  } | null;
}

export interface NativeReadTaskHelperResult {
  ok: boolean;
  status: string;
  flow_id: string;
  task_id: string;
  found: boolean;
  task: {
    taskId: string;
    status: string;
    revision: number;
    syncMode?: "managed" | "mirrored";
    state?: string;
    progressSummary?: string;
  } | null;
}

export interface NativeHelperInvoker {
  (input: NativeManagedFlowHelperInvokeArgs): NativeManagedFlowHelperResult;
  (input: NativeRunTaskHelperInvokeArgs): NativeRunTaskHelperResult;
  (input: NativeCancelFlowHelperInvokeArgs): NativeCancelFlowHelperResult;
  (input: NativeReadFlowHelperInvokeArgs): NativeReadFlowHelperResult;
  (input: NativeReadTaskHelperInvokeArgs): NativeReadTaskHelperResult;
}

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const HELPER_PATH = new URL("../../../../lib/openclaw_taskflow_runtime_helper.mjs", import.meta.url).pathname;

function buildCliArgs(action: NativeHelperAction, args: Record<string, string>): string[] {
  const cliArgs = [HELPER_PATH, action];
  for (const [key, value] of Object.entries(args)) {
    if (value === "") continue;
    cliArgs.push(`--${key}`.replace(/_/g, "-"), value);
  }
  return cliArgs;
}

function failClosed(message: string): never {
  throw new Error(`native helper invocation failed: ${message}`);
}

function ensureString(value: unknown, field: string): string {
  const text = String(value || "").trim();
  if (!text) {
    failClosed(`missing ${field}`);
  }
  return text;
}

function ensureNumber(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    failClosed(`invalid ${field}`);
  }
  return numeric;
}

function normalizeManagedFlowResult(payload: any): NativeManagedFlowHelperResult {
  if (payload?.ok !== true) {
    failClosed(payload?.error || payload?.status || "create-managed-flow returned non-ok response");
  }
  return {
    ok: true,
    flow_id: ensureString(payload.flow_id || payload.flow?.flowId, "flow_id"),
    flow: {
      flowId: ensureString(payload.flow?.flowId || payload.flow_id, "flow.flowId"),
      status: ensureString(payload.flow?.status, "flow.status"),
      revision: ensureNumber(payload.flow?.revision, "flow.revision"),
    },
  };
}

function normalizeRunTaskResult(payload: any): NativeRunTaskHelperResult {
  if (payload?.ok !== true) {
    failClosed(payload?.error || payload?.status || "run-task returned non-ok response");
  }
  const syncMode = ensureString(payload.task?.syncMode, "task.syncMode");
  if (syncMode !== "managed" && syncMode !== "mirrored") {
    failClosed(`invalid task.syncMode: ${syncMode}`);
  }
  return {
    ok: true,
    native_task_id: ensureString(payload.native_task_id || payload.task?.taskId, "native_task_id"),
    flow_id: ensureString(payload.flow_id, "flow_id"),
    task: {
      taskId: ensureString(payload.task?.taskId || payload.native_task_id, "task.taskId"),
      status: ensureString(payload.task?.status, "task.status"),
      syncMode,
      state: ensureString(payload.task?.state, "task.state"),
      revision: ensureNumber(payload.task?.revision, "task.revision"),
    },
  };
}

function normalizeCancelFlowResult(payload: any): NativeCancelFlowHelperResult {
  return {
    ok: payload?.ok === true,
    status: ensureString(payload?.status || "not_cancelled", "status"),
    flow_id: ensureString(payload?.flow_id, "flow_id"),
    found: payload?.found === true,
    cancelled: payload?.cancelled === true,
    reason: String(payload?.reason || "").trim(),
  };
}

function normalizeReadFlowResult(payload: any): NativeReadFlowHelperResult {
  return {
    ok: payload?.ok === true,
    status: ensureString(payload?.status || "not_found", "status"),
    flow_id: ensureString(payload?.flow_id, "flow_id"),
    found: payload?.found === true,
    flow: payload?.flow
      ? {
          flowId: ensureString(payload.flow.flowId || payload.flow_id, "flow.flowId"),
          status: ensureString(payload.flow.status, "flow.status"),
          revision: ensureNumber(payload.flow.revision, "flow.revision"),
          currentStep: String(payload.flow.currentStep || "").trim() || undefined,
        }
      : null,
  };
}

function normalizeReadTaskResult(payload: any): NativeReadTaskHelperResult {
  return {
    ok: payload?.ok === true,
    status: ensureString(payload?.status || "not_found", "status"),
    flow_id: ensureString(payload?.flow_id, "flow_id"),
    task_id: ensureString(payload?.task_id, "task_id"),
    found: payload?.found === true,
    task: payload?.task
      ? {
          taskId: ensureString(payload.task.taskId || payload.task_id, "task.taskId"),
          status: ensureString(payload.task.status, "task.status"),
          revision: ensureNumber(payload.task.revision, "task.revision"),
          syncMode: payload.task.syncMode === "managed" || payload.task.syncMode === "mirrored"
            ? payload.task.syncMode
            : undefined,
          state: String(payload.task.state || "").trim() || undefined,
          progressSummary: String(payload.task.progressSummary || "").trim() || undefined,
        }
      : null,
  };
}

export function invokeNativeHelper(input: NativeManagedFlowHelperInvokeArgs): NativeManagedFlowHelperResult;
export function invokeNativeHelper(input: NativeRunTaskHelperInvokeArgs): NativeRunTaskHelperResult;
export function invokeNativeHelper(input: NativeCancelFlowHelperInvokeArgs): NativeCancelFlowHelperResult;
export function invokeNativeHelper(input: NativeReadFlowHelperInvokeArgs): NativeReadFlowHelperResult;
export function invokeNativeHelper(input: NativeReadTaskHelperInvokeArgs): NativeReadTaskHelperResult;
export function invokeNativeHelper({ action, args }: NativeHelperInvokeArgs): NativeManagedFlowHelperResult | NativeRunTaskHelperResult | NativeCancelFlowHelperResult | NativeReadFlowHelperResult | NativeReadTaskHelperResult {
  const result = spawnSync("node", buildCliArgs(action, args), {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) {
    failClosed(result.error.message);
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    failClosed(result.stderr || "empty stdout");
  }
  let payload: any;
  try {
    payload = JSON.parse(stdout);
  } catch {
    failClosed(`invalid JSON: ${stdout}`);
  }
  if (action === "create-managed-flow") {
    return normalizeManagedFlowResult(payload);
  }
  if (action === "cancel-flow") {
    return normalizeCancelFlowResult(payload);
  }
  if (action === "read-flow") {
    return normalizeReadFlowResult(payload);
  }
  if (action === "read-task") {
    return normalizeReadTaskResult(payload);
  }
  return normalizeRunTaskResult(payload);
}
