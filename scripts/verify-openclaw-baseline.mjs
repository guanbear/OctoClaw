#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/verify-openclaw-baseline.mjs [--source <dir>] [--deploy-root <dir>] [--require-gateway]",
    "",
    "Checks that the OpenClaw source tree being consulted matches the OpenClaw package currently deployed.",
    "Defaults:",
    "  --deploy-root $OPENCLAW_DEPLOY_ROOT or ~/.local/lib/node_modules/openclaw",
  ].join("\n");
}

function fail(message) {
  console.error(`openclaw baseline mismatch: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  if (!existsSync(path)) {
    fail(`${label} not found at ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`failed to parse ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseArgs(argv) {
  const options = {
    deployRoot: process.env.OPENCLAW_DEPLOY_ROOT
      ? resolve(process.env.OPENCLAW_DEPLOY_ROOT)
      : resolve(homedir(), ".local/lib/node_modules/openclaw"),
    requireGateway: false,
    source: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--deploy-root") {
      const value = argv[index + 1];
      if (!value) fail("--deploy-root requires a value");
      options.deployRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value) fail("--source requires a value");
      options.source = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--require-gateway") {
      options.requireGateway = true;
      continue;
    }
    fail(`unknown argument ${arg}\n${usage()}`);
  }
  return options;
}

function normalizeCommit(value) {
  return typeof value === "string" ? value.trim() : "";
}

function verifyGatewayProcess(deployRoot) {
  const expected = `${deployRoot}/dist/index.js gateway`;
  let psOutput = "";
  try {
    psOutput = execFileSync("ps", ["-axo", "command"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`failed to inspect running processes: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!psOutput.includes(expected)) {
    fail(`running gateway does not appear to use ${expected}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const deployPackageJson = readJson(`${options.deployRoot}/package.json`, "deployed OpenClaw package.json");
const deployBuildInfo = readJson(`${options.deployRoot}/dist/build-info.json`, "deployed OpenClaw build-info.json");
const deployedVersion = String(deployPackageJson.version || "");
const buildInfoVersion = String(deployBuildInfo.version || "");
const deployedCommit = normalizeCommit(deployBuildInfo.commit || deployBuildInfo.head);

if (!deployedVersion) {
  fail("deployed OpenClaw package.json has no version");
}
if (!buildInfoVersion) {
  fail("deployed OpenClaw build-info.json has no version");
}
if (deployedVersion !== buildInfoVersion) {
  fail(`deployed package version ${deployedVersion} != build-info version ${buildInfoVersion}`);
}
if (!deployedCommit) {
  fail("deployed OpenClaw build-info.json has no commit/head");
}

if (options.source) {
  const sourcePackageJson = readJson(`${options.source}/package.json`, "source OpenClaw package.json");
  const sourceVersion = String(sourcePackageJson.version || "");
  if (sourceVersion !== deployedVersion) {
    fail(`source version ${sourceVersion || "<empty>"} != deployed version ${deployedVersion}`);
  }
  const sourceHead = runGit(["rev-parse", "HEAD"], options.source);
  if (sourceHead !== deployedCommit) {
    fail(`source HEAD ${sourceHead} != deployed commit ${deployedCommit}`);
  }
  const sourceStatus = runGit(["status", "--short"], options.source);
  if (sourceStatus) {
    fail(`source tree is dirty:\n${sourceStatus}`);
  }
}

if (options.requireGateway) {
  verifyGatewayProcess(options.deployRoot);
}

console.log([
  "openclaw baseline ok",
  `deployRoot=${options.deployRoot}`,
  `version=${deployedVersion}`,
  `commit=${deployedCommit}`,
  options.source ? `source=${options.source}` : "",
].filter(Boolean).join("\n"));
