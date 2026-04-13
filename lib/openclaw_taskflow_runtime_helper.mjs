#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  console.error(
    "Usage: openclaw_taskflow_runtime_helper.mjs <action> [options]\n" +
      "Actions:\n" +
      "  create-managed-flow  --session-key <key> --controller-id <id> --goal <text> [--status queued|running] [--current-step <step>] [--notify-policy <policy>] [--state-json <json>] [--openclaw-bin <bin>]\n" +
      "  run-task             --session-key <key> --flow-id <id> --task <text> [--runtime subagent] [--label <text>] [--run-id <id>] [--child-session-key <key>] [--status queued] [--notify-policy silent] [--progress-summary <text>]\n" +
      "  set-waiting          --session-key <key> --flow-id <id> --expected-revision <rev> [--current-step <step>] [--state-json <json>] [--wait-json <json>]\n" +
      "  finish-flow          --session-key <key> --flow-id <id> --expected-revision <rev> [--state-json <json>]\n" +
      "  fail-flow            --session-key <key> --flow-id <id> --expected-revision <rev> [--state-json <json>] [--blocked-task-id <id>] [--blocked-summary <text>]\n" +
      "  cancel-flow          --session-key <key> --flow-id <id>"
  );
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = { action: action || "" };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2).replace(/-/g, "_");
    const value = rest[index + 1] ?? "";
    options[key] = value;
    index += 1;
  }
  return options;
}

function parseFlexibleTimestamp(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function resolveExecutable(name) {
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
  const searchPath = String(process.env.PATH || "");
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

function findPackageRootFromBinary(openclawBin) {
  const binaryPath = resolveExecutable(openclawBin || "openclaw");
  if (!binaryPath) {
    throw new Error("openclaw CLI not found on PATH");
  }
  const candidates = [];
  let current = fs.statSync(binaryPath).isDirectory() ? binaryPath : path.dirname(binaryPath);
  while (true) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const prefix = path.dirname(path.dirname(binaryPath));
  candidates.push(path.join(prefix, "lib", "node_modules", "openclaw"));
  candidates.push(path.join(prefix, "node_modules", "openclaw"));
  for (const candidateRoot of candidates) {
    const packageJson = path.join(candidateRoot, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      if (parsed && parsed.name === "openclaw") {
        return candidateRoot;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Unable to resolve OpenClaw package root from ${binaryPath}`);
}

function findRuntimeModule(packageRoot) {
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

async function loadCreatePluginRuntime(openclawBin) {
  const packageRoot = findPackageRootFromBinary(openclawBin);
  const runtimeModule = findRuntimeModule(packageRoot);
  const text = fs.readFileSync(runtimeModule, "utf8");
  const exportMatch = text.match(/createPluginRuntime as (\w+)/);
  const exportName = exportMatch ? exportMatch[1] : "n";
  const moduleUrl = pathToFileURL(runtimeModule).href;
  const imported = await import(moduleUrl);
  const createPluginRuntime = imported[exportName];
  if (typeof createPluginRuntime !== "function") {
    throw new Error(`OpenClaw runtime bundle does not export createPluginRuntime (${exportName})`);
  }
  return createPluginRuntime;
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value);
}

async function createManagedFlow(options) {
  if (!options.session_key || !options.controller_id || !options.goal) {
    throw new Error("Missing required managed flow create arguments");
  }
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  if (!runtime || !runtime.taskFlow || typeof runtime.taskFlow.bindSession !== "function") {
    throw new Error("OpenClaw runtime does not expose taskFlow.bindSession");
  }
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  if (!bound || typeof bound.createManaged !== "function") {
    throw new Error("OpenClaw runtime does not expose taskFlow.createManaged");
  }
  const now = Date.now();
  const flow = bound.createManaged({
    controllerId: options.controller_id,
    status: options.status || "queued",
    notifyPolicy: options.notify_policy || "silent",
    goal: options.goal,
    currentStep: options.current_step || "",
    stateJson: parseJson(options.state_json, {}),
    waitJson: parseJson(options.wait_json, undefined),
    cancelRequestedAt: options.cancel_requested_at ? Number(options.cancel_requested_at) : undefined,
    createdAt: options.created_at ? parseFlexibleTimestamp(options.created_at) : now,
    updatedAt: options.updated_at ? parseFlexibleTimestamp(options.updated_at) : now,
    endedAt: options.ended_at ? parseFlexibleTimestamp(options.ended_at) : undefined,
  });
  return {
    ok: true,
    status: "ok",
    flow_id: String(flow?.flowId || ""),
    flow,
  };
}

async function runTask(options) {
  if (!options.session_key || !options.flow_id || !options.task) {
    throw new Error("Missing required run-task arguments: session-key, flow-id, task");
  }
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  const result = bound.runTask({
    flowId: options.flow_id,
    runtime: options.runtime || "subagent",
    task: options.task,
    label: options.label || "",
    runId: options.run_id || "",
    childSessionKey: options.child_session_key || "",
    status: options.status || "queued",
    notifyPolicy: options.notify_policy || "silent",
    progressSummary: options.progress_summary || "",
  });
  return {
    ok: result.created === true,
    status: result.created ? "ok" : "not_created",
    native_task_id: result.task?.taskId || "",
    flow_id: options.flow_id,
    task: result.task || null,
    reason: result.reason || "",
  };
}

async function setWaiting(options) {
  if (!options.session_key || !options.flow_id) throw new Error("Missing required args");
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  const result = bound.setWaiting({
    flowId: options.flow_id,
    expectedRevision: Number(options.expected_revision || 0),
    currentStep: options.current_step || "",
    stateJson: parseJson(options.state_json, undefined),
    waitJson: parseJson(options.wait_json, undefined),
  });
  return {
    ok: result.applied === true,
    status: result.applied ? "ok" : (result.code || "not_applied"),
    flow_id: options.flow_id,
    revision: result.flow?.revision || 0,
  };
}

async function finishFlow(options) {
  if (!options.session_key || !options.flow_id) throw new Error("Missing required args");
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  const result = bound.finish({
    flowId: options.flow_id,
    expectedRevision: Number(options.expected_revision || 0),
    stateJson: parseJson(options.state_json, undefined),
  });
  return {
    ok: result.applied === true,
    status: result.applied ? "ok" : (result.code || "not_applied"),
    flow_id: options.flow_id,
    revision: result.flow?.revision || 0,
  };
}

async function failFlow(options) {
  if (!options.session_key || !options.flow_id) throw new Error("Missing required args");
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  const result = bound.fail({
    flowId: options.flow_id,
    expectedRevision: Number(options.expected_revision || 0),
    stateJson: parseJson(options.state_json, undefined),
    blockedTaskId: options.blocked_task_id || "",
    blockedSummary: options.blocked_summary || "",
  });
  return {
    ok: result.applied === true,
    status: result.applied ? "ok" : (result.code || "not_applied"),
    flow_id: options.flow_id,
    revision: result.flow?.revision || 0,
  };
}

async function cancelFlow(options) {
  if (!options.session_key || !options.flow_id) throw new Error("Missing required args");
  const createPluginRuntime = await loadCreatePluginRuntime(options.openclaw_bin || "openclaw");
  const runtime = createPluginRuntime({});
  const bound = runtime.taskFlow.bindSession({ sessionKey: options.session_key });
  const result = bound.cancel({ flowId: options.flow_id, cfg: {} });
  return {
    ok: result.cancelled === true || result.found === true,
    status: result.cancelled ? "ok" : (result.reason || "not_cancelled"),
    flow_id: options.flow_id,
    found: result.found || false,
    cancelled: result.cancelled || false,
    reason: result.reason || "",
  };
}

const ACTION_HANDLERS = {
  "create-managed-flow": createManagedFlow,
  "run-task": runTask,
  "set-waiting": setWaiting,
  "finish-flow": finishFlow,
  "fail-flow": failFlow,
  "cancel-flow": cancelFlow,
};

async function main() {
  const HELPER_TIMEOUT_MS = 15_000;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: false, status: "timeout", error: `helper timed out after ${HELPER_TIMEOUT_MS}ms` }) + "\n");
    process.exit(1);
  }, HELPER_TIMEOUT_MS);
  const options = parseArgs(process.argv.slice(2));
  const handler = ACTION_HANDLERS[options.action];
  if (!handler) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const payload = await handler(options);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error || "unknown error"),
        action: options.action,
      })}\n`
    );
    process.exitCode = 1;
  }
}

await main();
