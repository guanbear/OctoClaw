import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

declare const process: { env: Record<string, string | undefined> };
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import {
  main,
  parseCliArgs,
  resolveRuntimeStateSurfaceRecord,
  runOctoClawCtl,
} from "./cli.js";


async function runTestCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    child.on("close", (code: number | null) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? 1}`)));
  });
}

function createRuntimeEnv(): Record<string, string> {
  return {
    OCTOCLAW_TASK_ID: "task-123",
    OCTOCLAW_FLOW_ID: "flow-456",
    OCTOCLAW_SUBSTRATE_STATE: "running",
    OCTOCLAW_SUBSTRATE_REVISION: "7",
    OCTOCLAW_CLAIM_OWNER: "worker-alpha",
    OCTOCLAW_WORKSPACE_MODE: "isolated_worktree",
    OCTOCLAW_WRITE_SCOPE_SUMMARY: "repo:src",
    OCTOCLAW_PROJECTION_STATUS: "projection-stale",
  };
}

function createRecord(): RuntimeStateSurfaceRecord {
  const record = resolveRuntimeStateSurfaceRecord(createRuntimeEnv());
  if (!record) {
    throw new Error("expected runtime record");
  }

  return record;
}

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => {
        stdout.push(message);
      },
      stderr: (message: string) => {
        stderr.push(message);
      },
    },
  };
}

describe("octoclawctl cli", () => {
  it("parses supported actions", () => {
    expect(parseCliArgs(["status"]).command).toBe("status");
    expect(parseCliArgs(["details"]).command).toBe("details");
    expect(parseCliArgs(["queue"]).command).toBe("queue");
    expect(parseCliArgs(["timeline"]).command).toBe("timeline");
  });

  it("parses management actions", () => {
    expect(parseCliArgs(["install"]).command).toBe("install");
    expect(parseCliArgs(["enable"]).command).toBe("enable");
    expect(parseCliArgs(["disable"]).command).toBe("disable");
    expect(parseCliArgs(["config", "set", "judge.modelId", "test-model"])).toMatchObject({
      command: "config",
      extraArgs: ["set", "judge.modelId", "test-model"],
    });
  });

  it("parses router-lite actions", () => {
    expect(parseCliArgs(["router", "model-intel", "refresh", "--format", "json"])).toMatchObject({
      command: "router",
      format: "json",
      extraArgs: ["model-intel", "refresh"],
    });
    expect(parseCliArgs(["router", "model-config", "analyze", "--input", "snapshot.json"])).toMatchObject({
      command: "router",
      input: "snapshot.json",
      extraArgs: ["model-config", "analyze"],
    });
  });

  it("valid actions produce output", async () => {
    for (const action of ["status", "details", "queue", "timeline"] as const) {
      const capture = createIo();
      const exitCode = await main([action], createRuntimeEnv(), capture.io);

      expect(exitCode).toBe(0);
      expect(capture.stdout[0]).toContain(action === "timeline" ? "Timeline:" : `${action[0].toUpperCase()}${action.slice(1)}:`);
      expect(capture.stderr).toEqual([]);
    }
  });

  it("unknown action returns error", async () => {
    const capture = createIo();
    const exitCode = await main(["bogus"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("Unknown action: bogus");
  });

  it("help prints usage", async () => {
    const capture = createIo();
    const exitCode = await main(["--help"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Usage: octoclawctl");
  });

  it("format json produces JSON output", async () => {
    const capture = createIo();
    const exitCode = await main(["status", "--format", "json"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout[0] ?? "")).toMatchObject({
      kind: "status_card",
      title: "task-123",
      state: "running",
    });
  });

  it("runOctoClawCtl library function still works", () => {
    const output = runOctoClawCtl("status", createRecord(), "text");

    expect(output).toContain("Status: task-123");
  });

  it("prints fallback message when no runtime data is available", async () => {
    const capture = createIo();
    const exitCode = await main(["status"], {}, capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.length).toBeGreaterThan(0);
  });

  it("config set/get reads and writes the unified config file", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      const setCapture = createIo();
      const setExitCode = await main(["config", "set", "judge.modelId", "test-model"], { OCTOCLAW_HOME: openclawHome }, setCapture.io);

      expect(setExitCode).toBe(0);
      expect(setCapture.stdout[0]).toBe("set judge.modelId");

      const raw = await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8");
      const saved = JSON.parse(raw);
      expect(saved.judge.modelId).toBe("test-model");
      expect(saved.pluginConfig.judgeFast).toBeUndefined();

      const setSpeculativeCapture = createIo();
      const setSpeculativeExitCode = await main(["config", "set", "pluginConfig.speculativePreload", "true"], { OCTOCLAW_HOME: openclawHome }, setSpeculativeCapture.io);
      expect(setSpeculativeExitCode).toBe(0);
      expect(setSpeculativeCapture.stdout[0]).toBe("set pluginConfig.speculativePreload");
      const savedWithSpeculative = JSON.parse(await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8"));
      expect(savedWithSpeculative.pluginConfig.speculativePreload).toBe(true);

      const getCapture = createIo();
      const getExitCode = await main(["config", "get", "judge.modelId"], { OCTOCLAW_HOME: openclawHome }, getCapture.io);
      expect(getExitCode).toBe(0);
      expect(getCapture.stdout[0]).toBe("test-model");

      const statusCapture = createIo();
      const statusExitCode = await main(["status"], { OCTOCLAW_HOME: openclawHome }, statusCapture.io);
      expect(statusExitCode).toBe(0);
      expect(statusCapture.stdout[0]).not.toContain("installed_at: 1970-01-01T00:00:00.000Z");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runtime manifest schema permits the speculative preload rollout flag", async () => {
    const manifestPath = path.join("extensions", "octoclaw-runtime", "openclaw.plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const properties = manifest.configSchema?.properties || {};

    expect(manifest.configSchema?.additionalProperties).toBe(false);
    expect(properties.speculativePreload).toMatchObject({ type: "boolean", default: false });
    expect(properties.speculative_preload).toMatchObject({ type: "boolean", default: false });
  });

  it("enable and disable update unified config and plugin projections", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `toggle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const fakeBin = path.join(tmpDir, "bin");
    try {
      await fs.mkdir(path.join(openclawHome, "extensions", "octoclaw-runtime"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json"), JSON.stringify({ id: "octoclaw-runtime", pluginConfig: { enabled: true } }), "utf8");
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({ plugins: { entries: { "octoclaw-runtime": { enabled: true, config: { octoclawRoot: "/repo" } } } } }), "utf8");
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.writeFile(path.join(fakeBin, "openclaw"), "#!/bin/sh\necho \"$@\" >> \"$OCTOCLAW_FAKE_LOG\"\n", "utf8");
      await runTestCommand("chmod", ["755", path.join(fakeBin, "openclaw")]);

      const disableCapture = createIo();
      const disableExitCode = await main(["disable", "--openclaw-home", openclawHome], { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, OCTOCLAW_FAKE_LOG: path.join(tmpDir, "openclaw.log") }, disableCapture.io);
      expect(disableExitCode).toBe(0);

      const disabledConfig = JSON.parse(await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8"));
      expect(disabledConfig.enabled).toBe(false);
      expect(disabledConfig.pluginConfig.enabled).toBe(false);
      const disabledManifest = JSON.parse(await fs.readFile(path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json"), "utf8"));
      expect(disabledManifest.pluginConfig.enabled).toBe(false);
      const disabledOpenClawConfig = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(disabledOpenClawConfig.plugins.entries["octoclaw-runtime"].enabled).toBe(true);
      expect(disabledOpenClawConfig.plugins.entries["octoclaw-runtime"].config.enabled).toBe(false);

      const enableCapture = createIo();
      const enableExitCode = await main(["enable", "--openclaw-home", openclawHome], { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, OCTOCLAW_FAKE_LOG: path.join(tmpDir, "openclaw.log") }, enableCapture.io);
      expect(enableExitCode).toBe(0);

      const enabledConfig = JSON.parse(await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8"));
      expect(enabledConfig.enabled).toBe(true);
      const enabledManifest = JSON.parse(await fs.readFile(path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json"), "utf8"));
      expect(enabledManifest.pluginConfig.enabled).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router-lite refresh and analyze write proposal artifacts without live routing", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const fakeBin = path.join(tmpDir, "bin");
    const outputDir = path.join(tmpDir, "router-lite");
    const fakeOpenClaw = path.join(fakeBin, "openclaw");
    try {
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(path.join(openclawHome, "workspace", "tmp", "octopus"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            cliproxyapi: {
              models: [
                {
                  id: "gpt-5.5",
                  input: ["text"],
                  contextWindow: 1000000,
                  reasoning: true,
                  cost: { input: 2, output: 10 },
                },
              ],
            },
          },
        },
      }), "utf8");
      await fs.writeFile(path.join(openclawHome, "workspace", "tmp", "octopus", "model-catalog.json"), JSON.stringify({
        models: [
          {
            id: "gpt-5.5-mini",
            provider: "cliproxyapi",
            configured: false,
            available: true,
            size_class: "mini",
            pricing: { input: 0.1, output: 0.4 },
            modalities: { input: ["text"] },
            capability_hints: { tool_call: "yes" },
          },
        ],
      }), "utf8");
      await fs.writeFile(fakeOpenClaw, [
        "#!/bin/sh",
        "if [ \"$*\" = \"models list --json\" ]; then",
        "  echo 'config warning before json'",
        "  echo '{\"models\":[{\"key\":\"cliproxyapi/gpt-5.5\",\"input\":[\"text\"],\"contextWindow\":1000000,\"available\":true,\"tags\":[\"configured\"],\"missing\":false}]}'",
        "elif [ \"$*\" = \"status --usage --json\" ]; then",
        "  echo '{\"usage\":{}}'",
        "elif [ \"$*\" = \"gateway usage-cost --days 3 --json\" ]; then",
        "  echo '{\"cost\":{}}'",
        "else",
        "  echo '{}'",
        "fi",
      ].join("\n"), "utf8");
      await runTestCommand("chmod", ["755", fakeOpenClaw]);

      const env = { PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
      const refreshCapture = createIo();
      const refreshExitCode = await main([
        "router",
        "model-intel",
        "refresh",
        "--openclaw-home",
        openclawHome,
        "--output-dir",
        outputDir,
        "--format",
        "json",
      ], env, refreshCapture.io);
      expect(refreshExitCode).toBe(0);
      const refreshSummary = JSON.parse(refreshCapture.stdout[0] ?? "{}");
      expect(refreshSummary).toMatchObject({ models: 2, configured: 1, proposalOnly: 1 });

      const snapshot = JSON.parse(await fs.readFile(path.join(outputDir, "model-intel-snapshot.json"), "utf8"));
      expect(snapshot.models.map((model: { modelKey: string }) => model.modelKey)).toEqual(expect.arrayContaining([
        "cliproxyapi/gpt-5.5",
        "cliproxyapi/gpt-5.5-mini",
      ]));

      const analyzeCapture = createIo();
      const analyzeExitCode = await main([
        "router",
        "model-config",
        "analyze",
        "--openclaw-home",
        openclawHome,
        "--output-dir",
        outputDir,
        "--format",
        "json",
      ], env, analyzeCapture.io);
      expect(analyzeExitCode).toBe(0);
      const analyzeSummary = JSON.parse(analyzeCapture.stdout[0] ?? "{}");
      expect(analyzeSummary.actions.add_configured_model).toBe(1);
      expect(JSON.parse(await fs.readFile(path.join(outputDir, "model-config-proposal.json"), "utf8")).proposals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "add_configured_model",
          candidateModel: "cliproxyapi/gpt-5.5-mini",
        }),
      ]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses install and deploy options", () => {
    expect(parseCliArgs(["install", "--repo-url", "repo", "--branch", "main", "--openclaw-home", "/tmp/openclaw", "--octoclaw-root", "/tmp/octoclaw", "--skip-build", "--restart"])).toMatchObject({
      command: "install",
      repoUrl: "repo",
      branch: "main",
      openclawHome: "/tmp/openclaw",
      octoclawRoot: "/tmp/octoclaw",
      skipBuild: true,
      restartServices: true,
    });
    expect(parseCliArgs(["deploy", "--ref=stable"])).toMatchObject({ command: "deploy", branch: "stable" });
  });

  it("deploy copies packages/extensions and syncs pluginConfig", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `deploy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoRoot = path.join(tmpDir, "repo");
    const openclawHome = path.join(tmpDir, ".openclaw");
    const packageRoot = path.join(repoRoot, "packages", "octoclaw-contracts");
    const extensionRoot = path.join(repoRoot, "extensions", "octoclaw-runtime");
    const fakeBin = path.join(tmpDir, "bin");
    try {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@octoclaw/contracts" }), "utf8");
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};", "utf8");
      await fs.mkdir(path.join(extensionRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(extensionRoot, "package.json"), JSON.stringify({ name: "@octoclaw/runtime" }), "utf8");
      await fs.writeFile(path.join(extensionRoot, "openclaw.plugin.json"), JSON.stringify({ id: "octoclaw-runtime", main: "./dist/index.js" }), "utf8");
      await fs.writeFile(path.join(extensionRoot, "dist", "index.js"), "export {};", "utf8");
      await fs.mkdir(path.join(openclawHome, "packages", "octoclaw-stale-package", "dist"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "packages", "octoclaw-stale-package", "dist", "old.js"), "export {};", "utf8");
      await fs.mkdir(path.join(openclawHome, "extensions", "octoclaw-old-extension", "dist"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "extensions", "octoclaw-old-extension", "openclaw.plugin.json"), JSON.stringify({ id: "octoclaw-old-extension", main: "./dist/index.js" }), "utf8");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.writeFile(path.join(fakeBin, "openclaw"), "#!/bin/sh\necho \"$@\" >> \"$OCTOCLAW_FAKE_LOG\"\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nif [ \"$1 $2\" = \"rev-parse HEAD\" ]; then echo test-commit; exit 0; fi\nif [ \"$1 $2\" = \"branch --show-current\" ]; then echo test-branch; exit 0; fi\nexit 0\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "rsync"), "#!/bin/bash\ndest=\"${@: -1}\"\nsrc=\"${@: -2:1}\"\nmkdir -p \"$dest\"\ncp -R \"$src\". \"$dest\"\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "ln"), "#!/bin/sh\n/bin/ln \"$@\"\n", "utf8");
      await runTestCommand("chmod", ["755", path.join(fakeBin, "openclaw"), path.join(fakeBin, "git"), path.join(fakeBin, "rsync"), path.join(fakeBin, "ln")]);

      const modelCapture = createIo();
      const modelExitCode = await main(["config", "set", "judge.modelId", "deploy-model"], { OCTOCLAW_HOME: openclawHome }, modelCapture.io);
      expect(modelExitCode).toBe(0);
      const baseUrlCapture = createIo();
      const baseUrlExitCode = await main(["config", "set", "judge.baseUrl", "http://localhost:11434/v1"], { OCTOCLAW_HOME: openclawHome }, baseUrlCapture.io);
      expect(baseUrlExitCode).toBe(0);
      const enabledCapture = createIo();
      const enabledExitCode = await main(["config", "set", "judge.enabled", "true"], { OCTOCLAW_HOME: openclawHome }, enabledCapture.io);
      expect(enabledExitCode).toBe(0);
      const localCapture = createIo();
      const localExitCode = await main(["config", "set", "judge.local", "true"], { OCTOCLAW_HOME: openclawHome }, localCapture.io);
      expect(localExitCode).toBe(0);
      const timeoutLocalCapture = createIo();
      const timeoutLocalExitCode = await main(["config", "set", "judge.timeoutLocalMs", "3000"], { OCTOCLAW_HOME: openclawHome }, timeoutLocalCapture.io);
      expect(timeoutLocalExitCode).toBe(0);
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        channels: { slack: { botToken: "xoxb-test", streaming: { mode: "partial", nativeTransport: true }, nativeStreaming: true } },
      }), "utf8");
      await fs.mkdir(path.join(openclawHome, "workspace"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "workspace", "AGENTS.md"), [
        "# AGENTS.md - Your Workspace",
        "",
        "<!-- octoclaw:core-rules v1.8.0 -->",
        "- 收到用户消息，第一个输出必须是文字，禁止先做工具调用。",
        "- 若查询状态，必须原样返回完整状态面板。",
        "<!-- /octoclaw:core-rules -->",
        "",
      ].join("\n"), "utf8");

      const deployCapture = createIo();
      const deployExitCode = await main(["deploy", "--octoclaw-root", repoRoot, "--openclaw-home", openclawHome, "--skip-build"], { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, OCTOCLAW_FAKE_LOG: path.join(tmpDir, "openclaw.log") }, deployCapture.io);
      expect(deployExitCode).toBe(0);
      expect(deployCapture.stdout[0]).toContain("OctoClaw deploy completed");

      const deployedManifest = JSON.parse(await fs.readFile(path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json"), "utf8"));
      expect(deployedManifest.pluginConfig.judgeFast.modelId).toBe("deploy-model");
      const unifiedConfig = JSON.parse(await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8"));
      expect(unifiedConfig.judge.modelId).toBe("deploy-model");
      expect(unifiedConfig.judge.local).toBe(true);
      expect(unifiedConfig.judge.timeoutLocalMs).toBe(3000);
      expect(unifiedConfig.pluginConfig.judgeFast.modelId).toBe("deploy-model");
      expect(unifiedConfig.pluginConfig.judgeFast.baseUrl).toBe("http://localhost:11434/v1");
      expect(unifiedConfig.pluginConfig.judgeFast.local).toBe(true);
      expect(unifiedConfig.pluginConfig.judgeFast.timeoutLocalMs).toBe(3000);
      const openclawConfig = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.enabled).toBe(true);
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.judgeFast.modelId).toBe("deploy-model");
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.judgeFast.baseUrl).toBe("http://localhost:11434/v1");
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.judgeFast.local).toBe(true);
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.judgeFast.timeoutLocalMs).toBe(3000);
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.octoclawRoot).toBe(repoRoot);
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.workspaceRoot).toBe(path.join(openclawHome, "workspace"));
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].hooks.allowPromptInjection).toBe(true);
      expect(openclawConfig.channels.slack.streaming).toEqual({ mode: "off", nativeTransport: false });
      expect(openclawConfig.channels.slack).not.toHaveProperty("nativeStreaming");
      const workspaceAgents = await fs.readFile(path.join(openclawHome, "workspace", "AGENTS.md"), "utf8");
      expect(workspaceAgents).toContain("octoclaw:core-rules v1.9.1");
      expect(workspaceAgents).toContain("主 Agent 不是最终 route authority");
      expect(workspaceAgents).toContain("旧 v1.8.0 规则");
      expect(workspaceAgents).toContain("默认给委派摘要");
      expect(workspaceAgents).not.toContain("需要 fresh lookup");
      expect(workspaceAgents).not.toContain("第一个输出必须是文字");
      expect(workspaceAgents).not.toContain("必须原样返回完整状态面板");
      expect(await fs.readFile(path.join(openclawHome, "packages", "octoclaw-contracts", "dist", "index.js"), "utf8")).toContain("export");
      await expect(fs.readFile(path.join(openclawHome, "packages", "octoclaw-stale-package", "dist", "old.js"), "utf8")).rejects.toThrow();
      await expect(fs.readFile(path.join(openclawHome, "extensions", "octoclaw-old-extension", "openclaw.plugin.json"), "utf8")).rejects.toThrow();
      expect(await fs.readFile(path.join(openclawHome, "octoclaw-source-manifest.json"), "utf8")).toContain("test-commit");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("deploy with default disabled judge does not project stale judgeFast", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `deploy-no-judge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoRoot = path.join(tmpDir, "repo");
    const openclawHome = path.join(tmpDir, ".openclaw");
    const extensionRoot = path.join(repoRoot, "extensions", "octoclaw-runtime");
    const fakeBin = path.join(tmpDir, "bin");
    try {
      await fs.mkdir(path.join(extensionRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(extensionRoot, "package.json"), JSON.stringify({ name: "@octoclaw/runtime" }), "utf8");
      await fs.writeFile(path.join(extensionRoot, "openclaw.plugin.json"), JSON.stringify({ id: "octoclaw-runtime", main: "./dist/index.js" }), "utf8");
      await fs.writeFile(path.join(extensionRoot, "dist", "index.js"), "export {};", "utf8");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        plugins: {
          entries: {
            "octoclaw-runtime": {
              enabled: true,
              config: {
                octoclawRoot: "/old-repo",
                judgeFast: { enabled: false, modelId: "", baseUrl: "", apiKey: "" },
              },
            },
          },
        },
      }), "utf8");
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.writeFile(path.join(fakeBin, "openclaw"), "#!/bin/sh\necho \"$@\" >> \"$OCTOCLAW_FAKE_LOG\"\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nif [ \"$1 $2\" = \"rev-parse HEAD\" ]; then echo test-commit; exit 0; fi\nif [ \"$1 $2\" = \"branch --show-current\" ]; then echo test-branch; exit 0; fi\nexit 0\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "rsync"), "#!/bin/bash\ndest=\"${@: -1}\"\nsrc=\"${@: -2:1}\"\nmkdir -p \"$dest\"\ncp -R \"$src\". \"$dest\"\n", "utf8");
      await fs.writeFile(path.join(fakeBin, "ln"), "#!/bin/sh\n/bin/ln \"$@\"\n", "utf8");
      await runTestCommand("chmod", ["755", path.join(fakeBin, "openclaw"), path.join(fakeBin, "git"), path.join(fakeBin, "rsync"), path.join(fakeBin, "ln")]);

      const deployCapture = createIo();
      const deployExitCode = await main(["deploy", "--octoclaw-root", repoRoot, "--openclaw-home", openclawHome, "--skip-build"], { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, OCTOCLAW_FAKE_LOG: path.join(tmpDir, "openclaw.log") }, deployCapture.io);
      expect(deployExitCode).toBe(0);

      const deployedManifest = JSON.parse(await fs.readFile(path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json"), "utf8"));
      expect(deployedManifest.pluginConfig.judgeFast).toBeUndefined();
      const unifiedConfig = JSON.parse(await fs.readFile(path.join(tmpDir, ".octoclaw", "config.json"), "utf8"));
      expect(unifiedConfig.pluginConfig.judgeFast).toBeUndefined();
      const openclawConfig = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.enabled).toBe(true);
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.judgeFast).toBeUndefined();
      expect(openclawConfig.plugins.entries["octoclaw-runtime"].config.octoclawRoot).toBe(repoRoot);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uninstall removes deployed packages, extensions, and OpenClaw plugin entry", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    try {
      await fs.mkdir(path.join(openclawHome, "extensions", "octoclaw-runtime"), { recursive: true });
      await fs.mkdir(path.join(openclawHome, "packages", "octoclaw-contracts"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        plugins: {
          entries: {
            "octoclaw-runtime": { enabled: true, config: { octoclawRoot: "/old/root" } },
            other: { enabled: true },
          },
        },
      }), "utf8");

      const capture = createIo();
      const exitCode = await main(["uninstall", "--openclaw-home", openclawHome], {}, capture.io);
      expect(exitCode).toBe(0);

      await runTestCommand("test", ["!", "-e", path.join(openclawHome, "extensions", "octoclaw-runtime")]);
      await runTestCommand("test", ["!", "-e", path.join(openclawHome, "packages", "octoclaw-contracts")]);
      const openclawConfig = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(openclawConfig.plugins.entries["octoclaw-runtime"]).toBeUndefined();
      expect(openclawConfig.plugins.entries.other.enabled).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses nightly command with required args", () => {
    const parsed = parseCliArgs(["nightly", "--input", "/tmp/replay.jsonl", "--output-dir", "/tmp/reports"]);
    expect(parsed.command).toBe("nightly");
    expect(parsed.input).toBe("/tmp/replay.jsonl");
    expect(parsed.outputDir).toBe("/tmp/reports");
    expect(parsed.nightlyFormat).toBe("markdown");
  });

  it("parses nightly command with --format json", () => {
    const parsed = parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "json"]);
    expect(parsed.command).toBe("nightly");
    expect(parsed.nightlyFormat).toBe("json");
  });

  it("nightly requires --input", () => {
    expect(() => parseCliArgs(["nightly", "--output-dir", "/tmp"])).toThrow("--input");
  });

  it("nightly requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl"])).toThrow("--output-dir");
  });

  it("nightly accepts --format markdown explicitly", () => {
    const parsed = parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "markdown"]);
    expect(parsed.nightlyFormat).toBe("markdown");
  });

  it("nightly rejects --format compact", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "compact"])).toThrow("Unknown format: compact");
  });

  it("nightly rejects --format table", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "table"])).toThrow("Unknown format: table");
  });

  it("nightly rejects --format lanes", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "lanes"])).toThrow("Unknown format: lanes");
  });

  it("nightly rejects --format anchors", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "anchors"])).toThrow("Unknown format: anchors");
  });

  it("non-nightly commands still accept --format compact", () => {
    const parsed = parseCliArgs(["status", "--format", "compact"]);
    expect(parsed.format).toBe("compact");
  });

  it("non-nightly commands still accept --format json", () => {
    const parsed = parseCliArgs(["status", "--format", "json"]);
    expect(parsed.format).toBe("json");
  });

  it("non-nightly commands reject --format markdown", () => {
    expect(() => parseCliArgs(["status", "--format", "markdown"])).toThrow("Unknown format: markdown");
  });

  it("parses slack-acceptance command with required args", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "acceptance.json", "--output-dir", "/tmp/reports"]);
    expect(parsed.command).toBe("slack-acceptance");
    expect(parsed.config).toBe("acceptance.json");
    expect(parsed.outputDir).toBe("/tmp/reports");
    expect(parsed.slackAcceptanceFormat).toBe("markdown");
  });

  it("slack-acceptance accepts --format json", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "json"]);
    expect(parsed.slackAcceptanceFormat).toBe("json");
  });

  it("slack-acceptance accepts --format markdown", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "markdown"]);
    expect(parsed.slackAcceptanceFormat).toBe("markdown");
  });

  it("slack-acceptance rejects --format compact", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "compact"])).toThrow("Unknown format: compact");
  });

  it("slack-acceptance requires --config", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--output-dir", "/tmp"])).toThrow("--config");
  });

  it("slack-acceptance requires --output-dir", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--config", "cfg.json"])).toThrow("--output-dir");
  });
});

describe("calibration-gate CLI parsing", () => {
  it("parses calibration-gate with all required args", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out"]);
    expect(result.command).toBe("calibration-gate");
    expect(result.baseline).toBe("b.json");
    expect(result.candidate).toBe("c.json");
    expect(result.outputDir).toBe("/tmp/out");
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("parses calibration-gate with --format json", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "json"]);
    expect(result.calibrationFormat).toBe("json");
  });

  it("parses calibration-gate with --format markdown", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "markdown"]);
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("rejects --format compact for calibration-gate", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "compact"]))
      .toThrow("Unknown format: compact");
  });

  it("requires --baseline", () => {
    expect(() => parseCliArgs(["calibration-gate", "--candidate", "c.json", "--output-dir", "/tmp/out"]))
      .toThrow("calibration-gate command requires --baseline");
  });

  it("requires --candidate", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--output-dir", "/tmp/out"]))
      .toThrow("calibration-gate command requires --candidate");
  });

  it("requires --output-dir", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json"]))
      .toThrow("calibration-gate command requires --output-dir");
  });

  it("supports --baseline= and --candidate= equals syntax", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline=b.json", "--candidate=c.json", "--output-dir=/tmp/out"]);
    expect(result.baseline).toBe("b.json");
    expect(result.candidate).toBe("c.json");
  });
});

describe("nightly-eval CLI parsing", () => {
  it("parses nightly-eval run with all required args", () => {
    const result = parseCliArgs(["nightly-eval", "run", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.command).toBe("nightly-eval");
    expect(result.nightlyEvalSubcommand).toBe("run");
    expect(result.config).toBe("eval.json");
    expect(result.outputDir).toBe("/tmp/out");
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("parses nightly-eval run with --format json", () => {
    const result = parseCliArgs(["nightly-eval", "run", "--config", "eval.json", "--output-dir", "/tmp/out", "--format", "json"]);
    expect(result.nightlyEvalSubcommand).toBe("run");
    expect(result.calibrationFormat).toBe("json");
  });

  it("parses nightly-eval install-launchagent with --schedule-hour", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour", "3"]);
    expect(result.nightlyEvalSubcommand).toBe("install-launchagent");
    expect(result.scheduleHour).toBe(3);
  });

  it("parses nightly-eval install-launchagent with --log-dir", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--log-dir", "/tmp/logs"]);
    expect(result.nightlyEvalSubcommand).toBe("install-launchagent");
    expect(result.logDir).toBe("/tmp/logs");
  });

  it("parses nightly-eval uninstall-launchagent", () => {
    const result = parseCliArgs(["nightly-eval", "uninstall-launchagent"]);
    expect(result.command).toBe("nightly-eval");
    expect(result.nightlyEvalSubcommand).toBe("uninstall-launchagent");
  });

  it("parses nightly-eval print-plist", () => {
    const result = parseCliArgs(["nightly-eval", "print-plist", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.nightlyEvalSubcommand).toBe("print-plist");
    expect(result.config).toBe("eval.json");
    expect(result.outputDir).toBe("/tmp/out");
  });

  it("parses nightly-eval deliver-slack", () => {
    const result = parseCliArgs(["nightly-eval", "deliver-slack", "--config", "slack.json", "--output-dir", "/tmp/reports"]);
    expect(result.nightlyEvalSubcommand).toBe("deliver-slack");
    expect(result.config).toBe("slack.json");
    expect(result.outputDir).toBe("/tmp/reports");
  });

  it("requires subcommand", () => {
    expect(() => parseCliArgs(["nightly-eval"]))
      .toThrow("nightly-eval requires a subcommand");
  });

  it("rejects invalid subcommand", () => {
    expect(() => parseCliArgs(["nightly-eval", "bad"]))
      .toThrow("Unknown nightly-eval subcommand");
  });

  it("run requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "run", "--output-dir", "/tmp/out"]))
      .toThrow("nightly-eval run requires --config");
  });

  it("deliver-slack requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "deliver-slack", "--output-dir", "/tmp/reports"]))
      .toThrow("nightly-eval deliver-slack requires --config");
  });

  it("deliver-slack requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "deliver-slack", "--config", "slack.json"]))
      .toThrow("nightly-eval deliver-slack requires --output-dir");
  });

  it("run requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "run", "--config", "eval.json"]))
      .toThrow("nightly-eval run requires --output-dir");
  });

  it("install-launchagent requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--output-dir", "/tmp/out"]))
      .toThrow("nightly-eval install-launchagent requires --config");
  });

  it("install-launchagent requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json"]))
      .toThrow("nightly-eval install-launchagent requires --output-dir");
  });

  it("rejects --schedule-hour out of range", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour", "25"]))
      .toThrow("Invalid --schedule-hour");
  });

  it("supports --schedule-hour= equals syntax", () => {
    const result = parseCliArgs(["nightly-eval", "print-plist", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour=4"]);
    expect(result.scheduleHour).toBe(4);
  });

  it("default schedule hour when not specified", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.scheduleHour).toBeUndefined();
  });
});



describe("octoclawctl nightly-eval integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), ".octoclawctl-test-tmp");
    tmpDir = path.join(base, `nightly-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates output directory and timestamped aggregate artifacts", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    const configPath = path.join(tmpDir, "nightly-eval.json");
    const outputDirPath = path.join(tmpDir, "nested", "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "reply", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(replayPath, `${JSON.stringify(event)}\n`, "utf8");
    await fs.writeFile(configPath, JSON.stringify({ replayPath }), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly-eval", "run", "--config", configPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Gate:");
    const entries = await fs.readdir(outputDirPath, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(fileNames.some((fileName) => /-nightly-eval\.json$/u.test(fileName))).toBe(true);
    expect(fileNames.some((fileName) => /-nightly-eval\.md$/u.test(fileName))).toBe(true);
    expect(fileNames.some((fileName) => /-nightly\.json$/u.test(fileName))).toBe(true);
  });



  it("review aggregates failure samples from nightly lanes", async () => {
    const reportPath = path.join(tmpDir, "nightly-eval.json");
    await fs.writeFile(reportPath, JSON.stringify({
      schemaVersion: "octoclaw.nightly_eval.report/v1",
      generatedAt: "2026-04-30T00:00:00.000Z",
      overallGate: "fail",
      steps: {
        nightly: {
          status: "fail",
          report: {
            lanes: [
              { lane: "route_quality", samples: [{ eventId: "evt-route", turnId: "turn-1", verdict: "false_delegate", reason: "route mismatch" }] },
              { lane: "delivery", samples: [{ eventId: "evt-delivery", taskId: "task-1", verdict: "delivery_failed", reason: "timeout" }] },
            ],
          },
        },
      },
    }), "utf8");

    const capture = createIo();
    const exitCode = await main(["review", "--input", reportPath, "--format", "json"], {}, capture.io);

    expect(exitCode).toBe(0);
    const output = JSON.parse(capture.stdout[0]);
    expect(output.failures).toHaveLength(2);
    expect(output.failures[0]).toMatchObject({ lane: "route_quality", eventId: "evt-route", turnId: "turn-1", verdict: "false_delegate" });
    expect(output.failures[1]).toMatchObject({ lane: "delivery", eventId: "evt-delivery", taskId: "task-1", verdict: "delivery_failed" });
  });

  it("nightly-eval promote rejects unknown gate", async () => {
    const reportPath = path.join(tmpDir, "unknown-nightly-eval.json");
    await fs.writeFile(reportPath, JSON.stringify({
      schemaVersion: "octoclaw.nightly_eval.report/v1",
      overallGate: "unknown",
    }), "utf8");

    const capture = createIo();
    const exitCode = await main(["nightly-eval", "promote", "--input", reportPath, "--openclaw-home", path.join(tmpDir, ".openclaw")], {}, capture.io);

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("unless gate=pass");
  });

  it("fails closed on malformed nightly-eval config", async () => {
    const configPath = path.join(tmpDir, "bad.json");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(configPath, JSON.stringify({ baseline: "only-baseline.json" }), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly-eval", "run", "--config", configPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("Nightly eval: malformed config JSON");
  });
});

describe("octoclawctl nightly integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), ".octoclawctl-test-tmp");
    tmpDir = path.join(base, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads JSONL, writes .json and .md reports, prints paths", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, JSON.stringify(event), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Written:");
    expect(capture.stdout[0]).toContain(".json");
    expect(capture.stdout[0]).toContain(".md");

    const entries = await fs.readdir(outputDirPath, { withFileTypes: true });
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(fileNames.some((f: string) => f.endsWith(".json"))).toBe(true);
    expect(fileNames.some((f: string) => f.endsWith(".md"))).toBe(true);
  });

  it("outputs JSON when --format json", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, JSON.stringify(event), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath, "--format", "json"],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(capture.stdout[0]);
    expect(report.reportId).toContain("nightly:");
    expect(report.lanes).toHaveLength(5);
  });

  it("fails on malformed JSONL events", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(inputPath, '{"bad":true}\n', "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("index 0");
  });

  it("fails on malformed JSON line with line number", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const e1 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, `${JSON.stringify(e1)}\n{bad json here\n`, "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("line 2");
  });

  it("fails on malformed JSON at first line", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(inputPath, "not json at all\n", "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("line 1");
  });

  it("handles multi-line JSONL input", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const e1 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", routerDecisionValid: true, confidence: 0.9 };
    const e2 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "delivery_observed", at: "2026-04-26T10:01:00.000Z" };
    await fs.writeFile(inputPath, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`, "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    const jsonPath = path.join(outputDirPath, "2026-04-26.json");
    const report = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    expect(report.inputEventCount).toBe(2);
  });
});
