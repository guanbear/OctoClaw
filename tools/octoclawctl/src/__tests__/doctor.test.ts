import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../commands/doctor.js";
import { writeConfig, type OctoclawConfig } from "../config.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

declare const process: { version: string };

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

function openClawFailure(): ReturnType<typeof spawnSync> {
  return {
    error: new Error("not found"),
    status: null,
    stdout: "",
    stderr: "",
    signal: null,
    output: [],
    pid: 0,
  };
}

async function makeHome(name: string): Promise<{ tmpDir: string; openclawHome: string }> {
  const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const openclawHome = path.join(tmpDir, ".openclaw");
  await fs.mkdir(openclawHome, { recursive: true });
  return { tmpDir, openclawHome };
}

function configuredConfig(baseUrl: string): OctoclawConfig {
  return {
    _version: "1",
    _updatedAt: new Date(0).toISOString(),
    enabled: true,
    features: { delegation: true, imNotifications: true, statusPanel: true },
    judge: {
      enabled: true,
      modelId: "judge-model",
      baseUrl,
      apiKey: "test-key",
      timeoutMs: 3000,
      timeoutLocalMs: 3000,
      minConfidence: 0.6,
      shadowMode: false,
      judgeAckEnabled: true,
      local: false,
    },
    models: { mode: "auto", overrides: {} },
    pluginConfig: {
      enabled: true,
      delegationEnabled: true,
      channels: { slack: { botToken: "xoxb-test" } },
    },
  };
}

describe("runDoctor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("ERR-D-001 runs with unconfigured state and outputs five checks", async () => {
    mockedSpawnSync.mockReturnValue(openClawFailure());
    const { tmpDir, openclawHome } = await makeHome("doctor-unconfigured");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output.match(/^(✅|⚠️|❌)/gmu)).toHaveLength(5);
      expect(result.output).toContain("Node.js");
      expect(result.output).toContain("OpenClaw");
      expect(result.output).toContain("Judge model");
      expect(result.output).toContain("IM tokens");
      expect(result.output).toContain("Config writable");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-002 marks Node.js >= 22 as pass", async () => {
    mockedSpawnSync.mockReturnValue(openClawFailure());
    vi.spyOn(process, "version", "get").mockReturnValue("v22.0.0");
    const { tmpDir, openclawHome } = await makeHome("doctor-node-pass");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("✅ Node.js");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-003 marks Node.js < 22 as fail and exits 1", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    vi.spyOn(process, "version", "get").mockReturnValue("v18.0.0");
    const { tmpDir, openclawHome } = await makeHome("doctor-node-fail");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("❌ Node.js");
      expect(result.output).toContain("Requires Node.js >= 22");
      expect(result.exitCode).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-004 marks missing OpenClaw as fail with install link", async () => {
    mockedSpawnSync.mockReturnValue(openClawFailure());
    const { tmpDir, openclawHome } = await makeHome("doctor-openclaw-fail");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("❌ OpenClaw");
      expect(result.output).toContain("https://github.com/openclaw/openclaw#installation");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-005 warns when judge is not configured without failing", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    const { tmpDir, openclawHome } = await makeHome("doctor-judge-warn");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("⚠️ Judge model");
      expect(result.output).toContain("not configured");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-006 warns when IM tokens are absent without failing", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    const { tmpDir, openclawHome } = await makeHome("doctor-im-warn");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("⚠️ IM tokens");
      expect(result.output).toContain("not configured");
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-007 exits 0 and summarizes pass count when all checks pass", async () => {
    mockedSpawnSync.mockReturnValue(openClawSuccess());
    vi.spyOn(process, "version", "get").mockReturnValue("v22.1.0");
    const { tmpDir, openclawHome } = await makeHome("doctor-all-pass");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await writeConfig(openclawHome, configuredConfig("http://127.0.0.1:12345"));

      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("5 pass, 0 warn, 0 fail");
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-008 exits 1 when any check fails", async () => {
    mockedSpawnSync.mockReturnValue(openClawFailure());
    const { tmpDir, openclawHome } = await makeHome("doctor-any-fail");
    try {
      const result = await runDoctor({ json: false, lang: "en", openclawHome });

      expect(result.output).toContain("❌ OpenClaw");
      expect(result.exitCode).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ERR-D-009 emits valid JSON with checks array", async () => {
    mockedSpawnSync.mockReturnValue(openClawFailure());
    const { tmpDir, openclawHome } = await makeHome("doctor-json");
    try {
      const result = await runDoctor({ json: true, lang: "en", openclawHome });
      const parsed = JSON.parse(result.output) as { checks?: unknown[] };

      expect(parsed.checks).toHaveLength(5);
      expect(parsed.checks?.[0]).toMatchObject({ name: "Node.js" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
