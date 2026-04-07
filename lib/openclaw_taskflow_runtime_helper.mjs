#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  console.error(
    "Usage: openclaw_taskflow_runtime_helper.mjs create-managed-flow " +
      "--session-key <key> --controller-id <id> --goal <text> [--status queued|running] " +
      "[--current-step <step>] [--notify-policy <policy>] [--state-json <json>] [--openclaw-bin <bin>]"
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
    createdAt: options.created_at ? Number(options.created_at) : now,
    updatedAt: options.updated_at ? Number(options.updated_at) : now,
    endedAt: options.ended_at ? Number(options.ended_at) : undefined,
  });
  return {
    ok: true,
    status: "ok",
    flow_id: String(flow?.flowId || ""),
    flow,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action !== "create-managed-flow") {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const payload = await createManagedFlow(options);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error || "unknown error"),
      })}\n`
    );
    process.exitCode = 1;
  }
}

await main();
