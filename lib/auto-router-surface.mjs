#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildBoundaryManifest } from "./auto-router-boundary.mjs";

const DEFAULT_WORKSPACE = "/workspace";

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function resolveWorkspace() {
  for (const envName of ["WORKSPACE", "OCTOCLAW_WORKSPACE"]) {
    const configured = String(process.env[envName] || "").trim();
    if (configured) return normalizePath(configured);
  }
  const managed = path.join(os.homedir(), ".openclaw", "workspace");
  if (fs.existsSync(path.join(managed, "tmp"))) return managed;
  return DEFAULT_WORKSPACE;
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function octopusTmpDir(workspace) {
  return path.join(workspace, "tmp", "octopus");
}

function factsSurface(workspace) {
  const tmpDir = octopusTmpDir(workspace);
  const catalogPath = path.join(tmpDir, "model-catalog.json");
  const policyPath = path.join(tmpDir, "model-policy.json");
  const sourceStatusPath = path.join(tmpDir, "model-intel-source-status.json");
  const catalog = loadJson(catalogPath);
  const policy = loadJson(policyPath);
  const sourceStatus = loadJson(sourceStatusPath);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const sources = sourceStatus.sources && typeof sourceStatus.sources === "object" ? sourceStatus.sources : {};
  const activeSources = Object.entries(sources)
    .filter(([, entry]) => entry && typeof entry === "object" && entry.active)
    .map(([name]) => name)
    .sort();
  const staleSources = Object.entries(sources)
    .filter(([, entry]) => entry && typeof entry === "object" && entry.freshness === "stale")
    .map(([name]) => name)
    .sort();
  return {
    schema_version: "octoclaw.auto_router.surface_facts/v1",
    workspace,
    files: {
      catalog: catalogPath,
      policy: policyPath,
      source_status: sourceStatusPath,
    },
    facts_plane:
      policy.facts_plane && typeof policy.facts_plane === "object"
        ? policy.facts_plane
        : catalog.facts_plane && typeof catalog.facts_plane === "object"
          ? catalog.facts_plane
          : {
              source_precedence: {},
              active_sources: activeSources,
              stale_sources: staleSources,
            },
    summary: {
      model_count: models.length,
      active_sources: activeSources,
      stale_sources: staleSources,
      main_model: String(policy.main_model || "").trim(),
    },
  };
}

function runPython(scriptName, args, workspace) {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), scriptName);
  const result = spawnSync("python3", [scriptPath, ...args], {
    cwd: path.resolve(path.dirname(scriptPath), ".."),
    env: { ...process.env, WORKSPACE: workspace },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Failed to run ${scriptName}\n`);
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
}

function main() {
  const workspace = resolveWorkspace();
  const [, , command = "help", ...args] = process.argv;

  if (command === "manifest") {
    process.stdout.write(`${JSON.stringify(buildBoundaryManifest(), null, 2)}\n`);
    return;
  }
  if (command === "facts") {
    process.stdout.write(`${JSON.stringify(factsSurface(workspace), null, 2)}\n`);
    return;
  }
  if (command === "recommend") {
    runPython("auto_router.py", args, workspace);
    return;
  }
  if (command === "eval") {
    runPython("router_eval.py", args, workspace);
    return;
  }

  process.stderr.write("Usage: auto-router-surface.mjs <manifest|facts|recommend|eval> [...args]\n");
  process.exit(2);
}

export const __autoRouterSurfaceTest = {
  resolveWorkspace,
  factsSurface,
};

main();
