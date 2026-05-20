import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "../cli.js";
import { defaultConfig, syncToOpenClawPluginConfig, writeConfig } from "../config.js";
import { cloneOrUpdate } from "../install.js";
import { generateReadinessReport } from "../readiness.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

vi.mock("../install.js", async () => {
  const actual = await vi.importActual<typeof import("../install.js")>("../install.js");
  return {
    ...actual,
    buildWorkspace: vi.fn(async () => {}),
    cloneOrUpdate: vi.fn(async () => {}),
    deployExtension: vi.fn(async (_octoclawRoot: string, openclawHome: string) => {
      const runtimeRoot = path.join(openclawHome, "extensions", "octoclaw-runtime");
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, "openclaw.plugin.json"), JSON.stringify({ main: "index.js" }), "utf8");
      await fs.writeFile(path.join(runtimeRoot, "index.js"), "export {};\n", "utf8");
    }),
    deployPackages: vi.fn(async (_octoclawRoot: string, openclawHome: string) => {
      await fs.mkdir(path.join(openclawHome, "packages", "octoclaw-status-surface"), { recursive: true });
    }),
    setupSymlinks: vi.fn(async () => {}),
    syncOctoClawCoreRules: vi.fn(async () => {}),
    syncOpenClawPluginEntry: vi.fn(async () => {}),
    syncSlackDeliveryHookCompatibility: vi.fn(async () => {}),
    validateLoad: vi.fn(async () => {}),
    writeSourceManifest: vi.fn(async () => {}),
  };
});

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedCloneOrUpdate = vi.mocked(cloneOrUpdate);

function openClawSuccess(): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: "openclaw v2026.4.29\n",
    stderr: "",
    signal: null,
    output: [],
    pid: 123,
  };
}

async function makeHome(name: string): Promise<{ tmpDir: string; openclawHome: string; octoclawRoot: string }> {
  const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const openclawHome = path.join(tmpDir, ".openclaw");
  const octoclawRoot = path.join(tmpDir, "repo");
  await fs.mkdir(openclawHome, { recursive: true });
  await fs.mkdir(octoclawRoot, { recursive: true });
  return { tmpDir, openclawHome, octoclawRoot };
}

describe("install readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("MOF-016 reports all setup surfaces without leaking secrets", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { tmpDir, openclawHome, octoclawRoot } = await makeHome("install-readiness-surfaces");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const config = defaultConfig();
      config.judge = {
        ...config.judge,
        enabled: true,
        modelId: "judge-model",
        baseUrl: "http://127.0.0.1:12345",
        apiKey: "sk-secret",
      };
      config.pluginConfig = {
        ...config.pluginConfig,
        channels: {
          slack: { botToken: "xoxb-secret" },
          feishu: { botToken: "Bearer hidden" },
        },
      };
      await fs.mkdir(path.join(openclawHome, "octoclaw"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "octoclaw", "router-wizard.json"), JSON.stringify({ completed: true }), "utf8");
      await fs.writeFile(path.join(openclawHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const exitCode = await main(
        ["install", "--openclaw-home", openclawHome, "--octoclaw-root", octoclawRoot, "--skip-build", "--lang", "en"],
        {},
        { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
      );
      const output = stdout.join("\n");

      expect(exitCode).toBe(0);
      expect(stderr).toHaveLength(0);
      for (const id of ["openclaw", "runtime_plugin", "judge", "im.slack", "im.feishu", "router_wizard", "status_panel"]) {
        expect(output).toContain(id);
      }
      expect(output).not.toMatch(/xoxb-|sk-|Bearer/u);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("MOF-017 keeps non-interactive install secret-free when Judge is missing", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    const { tmpDir, openclawHome, octoclawRoot } = await makeHome("install-non-interactive");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await main(
        ["deploy", "--openclaw-home", openclawHome, "--octoclaw-root", octoclawRoot, "--skip-build", "--non-interactive", "--lang", "en"],
        {},
        { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
      );
      const output = stdout.join("\n");

      expect(exitCode).toBe(0);
      expect(stderr).toHaveLength(0);
      expect(output).toContain("octoclawctl init");
      expect(output).not.toMatch(/api\s*key|API\s*key|enter.*key|prompt/iu);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses the current release branch by default for install/update", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    const { tmpDir, openclawHome, octoclawRoot } = await makeHome("install-default-branch");
    try {
      const exitCode = await main(
        ["install", "--openclaw-home", openclawHome, "--octoclaw-root", octoclawRoot, "--skip-build", "--lang", "en"],
        {},
        { stdout: () => {}, stderr: () => {} },
      );

      expect(exitCode).toBe(0);
      expect(mockedCloneOrUpdate).toHaveBeenCalledWith(octoclawRoot, expect.any(String), "v0.5.0");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("MOF-018 imports legacy judge-fast.json and treats Judge as configured", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { tmpDir, openclawHome } = await makeHome("install-legacy-judge");
    try {
      const config = defaultConfig();
      await fs.writeFile(
        path.join(openclawHome, "judge-fast.json"),
        `${JSON.stringify({ modelId: "legacy-judge", baseUrl: "http://127.0.0.1:23456", apiKey: "sk-legacy" }, null, 2)}\n`,
        "utf8",
      );

      await syncToOpenClawPluginConfig(openclawHome, config);
      await writeConfig(openclawHome, config);
      const report = await generateReadinessReport(openclawHome);
      const judge = report.checks.find((check) => check.id === "judge");

      expect(config.judge).toMatchObject({ enabled: true, modelId: "legacy-judge", baseUrl: "http://127.0.0.1:23456" });
      expect(judge).toMatchObject({ id: "judge", status: "pass" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
