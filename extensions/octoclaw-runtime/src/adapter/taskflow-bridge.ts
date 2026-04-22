import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

interface PluginRuntimeTaskFlowBoundSession {
  createManaged?: (input: JsonRecord) => JsonRecord;
  runTask?: (input: JsonRecord) => JsonRecord;
  getFlow?: (input: { flowId: string }) => JsonRecord | null;
  setWaiting?: (input: JsonRecord) => JsonRecord;
  finish?: (input: JsonRecord) => JsonRecord;
  fail?: (input: JsonRecord) => JsonRecord;
  cancel?: (input: { flowId: string; cfg: JsonRecord }) => JsonRecord;
}

interface PluginRuntimeTaskFlow {
  bindSession?: (input: { sessionKey: string }) => PluginRuntimeTaskFlowBoundSession;
}

interface PluginRuntime {
  taskFlow?: PluginRuntimeTaskFlow;
}

type CreatePluginRuntime = (options: JsonRecord) => PluginRuntime;

export interface CreateManagedFlowInput {
  sessionKey: string;
  controllerId: string;
  goal: string;
  status?: string;
  currentStep?: string;
  notifyPolicy?: string;
  stateJson?: string;
  waitJson?: string;
  cancelRequestedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  openclawBin?: string;
}

export interface RunTaskInput {
  sessionKey: string;
  flowId: string;
  task: string;
  runtime?: string;
  label?: string;
  runId?: string;
  childSessionKey?: string;
  status?: string;
  notifyPolicy?: string;
  progressSummary?: string;
  openclawBin?: string;
}

export interface ReadFlowInput {
  sessionKey: string;
  flowId: string;
  openclawBin?: string;
}

export interface ReadTaskInput extends ReadFlowInput {
  taskId: string;
}

export interface SetWaitingInput extends ReadFlowInput {
  expectedRevision?: string;
  currentStep?: string;
  stateJson?: string;
  waitJson?: string;
}

export interface FinishFlowInput extends ReadFlowInput {
  expectedRevision?: string;
  stateJson?: string;
}

export interface FailFlowInput extends FinishFlowInput {
  blockedTaskId?: string;
  blockedSummary?: string;
}

export interface CancelFlowInput extends ReadFlowInput {}

export interface TaskFlowBridge {
  createManagedFlow(input: CreateManagedFlowInput): JsonRecord;
  runTask(input: RunTaskInput): JsonRecord;
  readFlow(input: ReadFlowInput): JsonRecord;
  readTask(input: ReadTaskInput): JsonRecord;
  setWaiting(input: SetWaitingInput): JsonRecord;
  finishFlow(input: FinishFlowInput): JsonRecord;
  failFlow(input: FailFlowInput): JsonRecord;
  cancelFlow(input: CancelFlowInput): JsonRecord;
}

function parseFlexibleTimestamp(value: unknown): number {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function parseJson(value: string | undefined, fallback: unknown): unknown {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveExecutable(name: string): string {
  if (!name) {
    return "";
  }
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return fs.realpathSync(name);
    } catch {
      return "";
    }
  }
  const searchPath = asString(process.env.PATH);
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return "";
}

function findOpenClawRootFromPath(startPath: string): string {
  let current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
      if (parsed.name === "openclaw") {
        return current;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return "";
}

function resolvePackageRoot(openclawBin?: string): string {
  if (openclawBin) {
    const binaryPath = resolveExecutable(openclawBin);
    if (!binaryPath) {
      throw new Error(`openclaw CLI not found: ${openclawBin}`);
    }
    const fromBinary = findOpenClawRootFromPath(binaryPath);
    if (fromBinary) {
      return fromBinary;
    }
    const prefix = path.dirname(path.dirname(binaryPath));
    const candidateRoots = [
      path.join(prefix, "lib", "node_modules", "openclaw"),
      path.join(prefix, "node_modules", "openclaw"),
    ];
    for (const candidate of candidateRoots) {
      if (findOpenClawRootFromPath(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Unable to resolve OpenClaw package root from ${binaryPath}`);
  }

  const argvEntry = asString(process.argv[1]);
  if (argvEntry) {
    const argvResolved = findOpenClawRootFromPath(argvEntry);
    if (argvResolved) {
      return argvResolved;
    }
  }

  const pathResolved = resolveExecutable("openclaw");
  if (pathResolved) {
    const pathRoot = resolvePackageRoot(pathResolved);
    if (pathRoot) {
      return pathRoot;
    }
  }

  throw new Error("openclaw runtime unavailable: unable to resolve package root");
}

function findRuntimeModule(packageRoot: string): string {
  const distDir = path.join(packageRoot, "dist");
  const entries = fs.readdirSync(distDir);
  let fallback = "";
  for (const entry of entries) {
    if (!/^runtime-.*\.js$/.test(entry) || entry.startsWith("runtime-api-") || entry.startsWith("runtime-store-")) {
      continue;
    }
    const candidate = path.join(distDir, entry);
    const text = fs.readFileSync(candidate, "utf8");
    if (!text.includes("createPluginRuntime")) {
      continue;
    }
    if (!fallback) {
      fallback = candidate;
    }
    if (text.includes("createRuntimeTaskFlow")) {
      return candidate;
    }
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`Unable to find OpenClaw runtime bundle under ${distDir}`);
}

async function loadCreatePluginRuntime(openclawBin?: string): Promise<CreatePluginRuntime> {
  const packageRoot = resolvePackageRoot(openclawBin);
  const runtimeModule = findRuntimeModule(packageRoot);
  const text = fs.readFileSync(runtimeModule, "utf8");
  const exportMatch = text.match(/createPluginRuntime as (\w+)/);
  const exportName = exportMatch ? exportMatch[1] : "n";
  const imported = await import(pathToFileURL(runtimeModule).href) as Record<string, unknown>;
  const createPluginRuntime = imported[exportName];
  if (typeof createPluginRuntime !== "function") {
    throw new Error(`OpenClaw runtime bundle does not export createPluginRuntime (${exportName})`);
  }
  return createPluginRuntime as CreatePluginRuntime;
}

export async function loadOpenClawDistModule(
  relativePath: string,
  openclawBin?: string,
): Promise<Record<string, unknown>> {
  const packageRoot = resolvePackageRoot(openclawBin);
  const modulePath = path.join(packageRoot, "dist", relativePath);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing OpenClaw dist module: ${modulePath}`);
  }
  return await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
}

function requireBoundSession(runtime: PluginRuntime, sessionKey: string): PluginRuntimeTaskFlowBoundSession {
  const bindSession = runtime.taskFlow?.bindSession;
  if (typeof bindSession !== "function") {
    throw new Error("OpenClaw runtime does not expose taskFlow.bindSession");
  }
  const bound = bindSession({ sessionKey });
  if (!bound) {
    throw new Error("OpenClaw runtime returned empty taskFlow session binding");
  }
  return bound;
}

function unavailableBridge(reason: string): TaskFlowBridge {
  const fail = (): never => {
    throw new Error(reason);
  };
  return {
    createManagedFlow: fail,
    runTask: fail,
    readFlow: fail,
    readTask: fail,
    setWaiting: fail,
    finishFlow: fail,
    failFlow: fail,
    cancelFlow: fail,
  };
}

export async function createTaskFlowBridge(openclawBin?: string): Promise<TaskFlowBridge> {
  try {
    const createPluginRuntime = await loadCreatePluginRuntime(openclawBin);

    const boundFor = (sessionKey: string): PluginRuntimeTaskFlowBoundSession => {
      const runtime = createPluginRuntime({});
      return requireBoundSession(runtime, sessionKey);
    };

    return {
      createManagedFlow: (input) => {
        if (!input.sessionKey || !input.controllerId || !input.goal) {
          throw new Error("Missing required managed flow create arguments");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.createManaged !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.createManaged");
        }
        const now = Date.now();
        const flow = bound.createManaged({
          controllerId: input.controllerId,
          status: input.status || "queued",
          notifyPolicy: input.notifyPolicy || "silent",
          goal: input.goal,
          currentStep: input.currentStep || "",
          stateJson: parseJson(input.stateJson, {}),
          waitJson: parseJson(input.waitJson, undefined),
          cancelRequestedAt: input.cancelRequestedAt ? Number(input.cancelRequestedAt) : undefined,
          createdAt: input.createdAt ? parseFlexibleTimestamp(input.createdAt) : now,
          updatedAt: input.updatedAt ? parseFlexibleTimestamp(input.updatedAt) : now,
          endedAt: input.endedAt ? parseFlexibleTimestamp(input.endedAt) : undefined,
        });
        return {
          ok: true,
          status: "ok",
          flow_id: asString(flow.flowId),
          flow,
        };
      },
      runTask: (input) => {
        if (!input.sessionKey || !input.flowId || !input.task) {
          throw new Error("Missing required run-task arguments: session-key, flow-id, task");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.runTask !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.runTask");
        }
        const result = asRecord(bound.runTask({
          flowId: input.flowId,
          runtime: input.runtime || "subagent",
          task: input.task,
          label: input.label || "",
          runId: input.runId || "",
          childSessionKey: input.childSessionKey || "",
          status: input.status || "queued",
          notifyPolicy: input.notifyPolicy || "silent",
          progressSummary: input.progressSummary || "",
        }));
        return {
          ok: result.created === true,
          status: result.created === true ? "ok" : "not_created",
          native_task_id: asString(asRecord(result.task).taskId),
          flow_id: input.flowId,
          task: result.task ?? null,
          reason: asString(result.reason),
        };
      },
      readFlow: (input) => {
        if (!input.sessionKey || !input.flowId) {
          throw new Error("Missing required read-flow arguments: session-key, flow-id");
        }
        const bound = boundFor(input.sessionKey);
        const flow = typeof bound.getFlow === "function" ? bound.getFlow({ flowId: input.flowId }) : null;
        if (!flow) {
          return {
            ok: false,
            status: "not_found",
            flow_id: input.flowId,
            found: false,
            flow: null,
          };
        }
        return {
          ok: true,
          status: "ok",
          flow_id: input.flowId,
          found: true,
          flow,
        };
      },
      readTask: (input) => {
        if (!input.sessionKey || !input.flowId || !input.taskId) {
          throw new Error("Missing required read-task arguments: session-key, flow-id, task-id");
        }
        const bound = boundFor(input.sessionKey);
        const flow = typeof bound.getFlow === "function" ? bound.getFlow({ flowId: input.flowId }) : null;
        const tasks = Array.isArray(asRecord(flow).tasks) ? asRecord(flow).tasks as unknown[] : [];
        const task = tasks.find((entry) => asString(asRecord(entry).taskId) === input.taskId) ?? null;
        if (!task) {
          return {
            ok: false,
            status: "not_found",
            flow_id: input.flowId,
            task_id: input.taskId,
            found: false,
            task: null,
          };
        }
        return {
          ok: true,
          status: "ok",
          flow_id: input.flowId,
          task_id: input.taskId,
          found: true,
          task,
        };
      },
      setWaiting: (input) => {
        if (!input.sessionKey || !input.flowId) {
          throw new Error("Missing required args");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.setWaiting !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.setWaiting");
        }
        const result = asRecord(bound.setWaiting({
          flowId: input.flowId,
          expectedRevision: Number(input.expectedRevision || 0),
          currentStep: input.currentStep || "",
          stateJson: parseJson(input.stateJson, undefined),
          waitJson: parseJson(input.waitJson, undefined),
        }));
        return {
          ok: result.applied === true,
          status: result.applied === true ? "ok" : (asString(result.code) || "not_applied"),
          flow_id: input.flowId,
          revision: Number(asRecord(result.flow).revision || 0),
        };
      },
      finishFlow: (input) => {
        if (!input.sessionKey || !input.flowId) {
          throw new Error("Missing required args");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.finish !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.finish");
        }
        const result = asRecord(bound.finish({
          flowId: input.flowId,
          expectedRevision: Number(input.expectedRevision || 0),
          stateJson: parseJson(input.stateJson, undefined),
        }));
        return {
          ok: result.applied === true,
          status: result.applied === true ? "ok" : (asString(result.code) || "not_applied"),
          flow_id: input.flowId,
          revision: Number(asRecord(result.flow).revision || 0),
        };
      },
      failFlow: (input) => {
        if (!input.sessionKey || !input.flowId) {
          throw new Error("Missing required args");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.fail !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.fail");
        }
        const result = asRecord(bound.fail({
          flowId: input.flowId,
          expectedRevision: Number(input.expectedRevision || 0),
          stateJson: parseJson(input.stateJson, undefined),
          blockedTaskId: input.blockedTaskId || "",
          blockedSummary: input.blockedSummary || "",
        }));
        return {
          ok: result.applied === true,
          status: result.applied === true ? "ok" : (asString(result.code) || "not_applied"),
          flow_id: input.flowId,
          revision: Number(asRecord(result.flow).revision || 0),
        };
      },
      cancelFlow: (input) => {
        if (!input.sessionKey || !input.flowId) {
          throw new Error("Missing required args");
        }
        const bound = boundFor(input.sessionKey);
        if (typeof bound.cancel !== "function") {
          throw new Error("OpenClaw runtime does not expose taskFlow.cancel");
        }
        const result = asRecord(bound.cancel({ flowId: input.flowId, cfg: {} }));
        return {
          ok: result.cancelled === true || result.found === true,
          status: result.cancelled === true ? "ok" : (asString(result.reason) || "not_cancelled"),
          flow_id: input.flowId,
          found: result.found === true,
          cancelled: result.cancelled === true,
          reason: asString(result.reason),
        };
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    return unavailableBridge(`openclaw runtime unavailable: ${message}`);
  }
}
