import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type NativeHelperAction = "create-managed-flow" | "run-task";

export interface NativeHelperInvokeArgs {
  action: NativeHelperAction;
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

export type NativeHelperInvoker = (
  input: NativeHelperInvokeArgs,
) => NativeManagedFlowHelperResult | NativeRunTaskHelperResult;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const HELPER_PATH = path.join(REPO_ROOT, "lib", "openclaw_taskflow_runtime_helper.mjs");

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

export const invokeNativeHelper: NativeHelperInvoker = ({ action, args }) => {
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
  return normalizeRunTaskResult(payload);
};
