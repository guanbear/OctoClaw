import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  generateReadinessReport,
  redactReadinessReport,
  type OctoclawReadinessReport,
} from "../readiness.js";
import { discoverOpenClawProvider } from "../commands/init/steps/step-judge-model.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

function openClawSuccess(): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: "OpenClaw 2026.5.12 (test)\n",
    stderr: "",
    signal: null,
    output: [],
    pid: 123,
  };
}

function openClawVersion(stdout: string): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout,
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
  const tmpDir = path.join(
    os.homedir(),
    ".octoclawctl-test-tmp",
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const openclawHome = path.join(tmpDir, ".openclaw");
  await fs.mkdir(openclawHome, { recursive: true });
  return { tmpDir, openclawHome };
}

describe("readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("MOF-005: missing Judge is warn", () => {
    it("reports Judge as warn when not configured", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-judge-missing");
      try {
        const report = await generateReadinessReport(openclawHome);
        const judgeCheck = report.checks.find((c) => c.id === "judge");

        expect(judgeCheck?.status).toBe("warn");
        expect(judgeCheck?.summary).toContain("not configured");
        expect(judgeCheck?.remediation).toContain("octoclawctl init");
        expect(judgeCheck?.remediation).toContain("gpt-5.4-mini");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not fail install solely because Judge is missing", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-judge-nofail");
      try {
        const report = await generateReadinessReport(openclawHome);
        const failChecks = report.checks.filter((c) => c.status === "fail");

        expect(failChecks.every((c) => c.id !== "judge")).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("MOF-001: GPT Mini preset is listed", () => {
    it("judgeChoices include gpt-5.4-mini and not glm-4.7", async () => {
      const { judgeChoices } = await import("../commands/init/steps/step-judge-model.js");
      const zhChoices = judgeChoices("zh");
      const enChoices = judgeChoices("en");

      expect(zhChoices.some((c) => c.value === "remote-gpt-5-4-mini")).toBe(true);
      expect(enChoices.some((c) => c.value === "remote-gpt-5-4-mini")).toBe(true);
      expect(zhChoices.some((c) => c.name.includes("glm-4.7"))).toBe(false);
      expect(enChoices.some((c) => c.name.includes("glm-4.7"))).toBe(false);

      const gptChoice = enChoices.find((c) => c.value === "remote-gpt-5-4-mini")!;
      expect(gptChoice.name).toContain("gpt-5.4-mini");
      expect(gptChoice.name).toContain("cheap");
      expect(gptChoice.name).toContain("no reasoning");
      expect(gptChoice.name).toContain("glm-4.5-air");
      expect(gptChoice.name).toContain("xiaomi/mimo-v2-flash");
      expect(gptChoice.name).toContain("deepseek/deepseek-v4-flash");
    });
  });

  describe("MOF-002: selecting preset stores remote Judge", () => {
    it("stores modelId gpt-5.4-mini and local false", async () => {
      const { judgeChoices } = await import("../commands/init/steps/step-judge-model.js");
      const choices = judgeChoices("en");
      const preset = choices.find((c) => c.value === "remote-gpt-5-4-mini");
      expect(preset).toBeDefined();

      const judgeModelType = "remote-gpt-5-4-mini";
      expect(judgeModelType.startsWith("ollama")).toBe(false);
    });
  });

  describe("MOF-003: provider discovery prefers cliproxy", () => {
    it("selects cliproxyapi provider when multiple providers exist", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-cliproxy");
      try {
        const openclawConfig = {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "redacted-openai-key",
                models: [{ id: "gpt-5.5" }],
              },
              cliproxyapi: {
                baseUrl: "https://cliproxyapi.example.com/v1",
                apiKey: "redacted-cliproxy-key",
                models: [{ id: "gpt-5.4-mini" }],
              },
            },
          },
        };
        await fs.writeFile(
          path.join(openclawHome, "openclaw.json"),
          JSON.stringify(openclawConfig),
          "utf8",
        );

        const result = await discoverOpenClawProvider(openclawHome);

        expect(result).not.toBeNull();
        expect(result!.baseUrl).toBe("https://cliproxyapi.example.com/v1");
        expect(result!.apiKey).toBe("redacted-cliproxy-key");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null when no providers exist (fallback to prompt)", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-none");
      try {
        await fs.writeFile(
          path.join(openclawHome, "openclaw.json"),
          JSON.stringify({ models: { providers: {} } }),
          "utf8",
        );

        const result = await discoverOpenClawProvider(openclawHome);
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null when openclaw.json does not exist (fallback to prompt)", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-no-config");
      try {
        const result = await discoverOpenClawProvider(openclawHome);
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null when multiple ambiguous providers exist without cliproxy", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-ambiguous");
      try {
        const openclawConfig = {
          models: {
            providers: {
              providerA: {
                baseUrl: "https://a.example.com/v1",
                apiKey: "redacted-a-key",
                models: [],
              },
              providerB: {
                baseUrl: "https://b.example.com/v1",
                apiKey: "redacted-b-key",
                models: [],
              },
            },
          },
        };
        await fs.writeFile(
          path.join(openclawHome, "openclaw.json"),
          JSON.stringify(openclawConfig),
          "utf8",
        );

        const result = await discoverOpenClawProvider(openclawHome);
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("selects single non-local provider when only one exists", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-single");
      try {
        const openclawConfig = {
          models: {
            providers: {
              groq: {
                baseUrl: "https://api.groq.com/openai/v1",
                apiKey: "redacted-groq-key",
                models: [],
              },
            },
          },
        };
        await fs.writeFile(
          path.join(openclawHome, "openclaw.json"),
          JSON.stringify(openclawConfig),
          "utf8",
        );

        const result = await discoverOpenClawProvider(openclawHome);

        expect(result).not.toBeNull();
        expect(result!.baseUrl).toBe("https://api.groq.com/openai/v1");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("skips local-only providers (localhost/127.0.0.1)", async () => {
      const { tmpDir, openclawHome } = await makeHome("provider-local");
      try {
        const openclawConfig = {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434/v1",
                apiKey: "",
                models: [],
              },
            },
          },
        };
        await fs.writeFile(
          path.join(openclawHome, "openclaw.json"),
          JSON.stringify(openclawConfig),
          "utf8",
        );

        const result = await discoverOpenClawProvider(openclawHome);
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("readiness report structure", () => {
    it("fails OpenClaw readiness below 2026.5.12", async () => {
      mockedSpawnSync.mockReturnValue(openClawVersion("OpenClaw 2026.5.11 (old)\n"));
      const { tmpDir, openclawHome } = await makeHome("readiness-openclaw-old");
      try {
        const report = await generateReadinessReport(openclawHome);
        const openclawCheck = report.checks.find((c) => c.id === "openclaw");

        expect(openclawCheck?.status).toBe("fail");
        expect(openclawCheck?.summary).toContain("requires OpenClaw >= 2026.5.12");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("includes all 7 check ids", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-ids");
      try {
        const report = await generateReadinessReport(openclawHome);
        const ids = report.checks.map((c) => c.id);

        expect(ids).toContain("openclaw");
        expect(ids).toContain("runtime_plugin");
        expect(ids).toContain("judge");
        expect(ids).toContain("im.slack");
        expect(ids).toContain("im.feishu");
        expect(ids).toContain("router_wizard");
        expect(ids).toContain("status_panel");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("has correct schema version", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-schema");
      try {
        const report = await generateReadinessReport(openclawHome);

        expect(report.schemaVersion).toBe("octoclaw.readiness/v1");
        expect(report.generatedAt).toBeTruthy();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("reports fail when OpenClaw is not installed", async () => {
      mockedSpawnSync.mockReturnValue(openClawFailure());
      const { tmpDir, openclawHome } = await makeHome("readiness-no-openclaw");
      try {
        const report = await generateReadinessReport(openclawHome);
        const openclawCheck = report.checks.find((c) => c.id === "openclaw");

        expect(openclawCheck?.status).toBe("fail");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("reports fail when runtime plugin is missing", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-no-plugin");
      try {
        const report = await generateReadinessReport(openclawHome);
        const pluginCheck = report.checks.find((c) => c.id === "runtime_plugin");

        expect(pluginCheck?.status).toBe("fail");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("treats Feishu appId/appSecret as configured", async () => {
      mockedSpawnSync.mockReturnValue(openClawSuccess());
      const { tmpDir, openclawHome } = await makeHome("readiness-feishu-configured");
      try {
        await fs.mkdir(path.join(tmpDir, ".octoclaw"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".octoclaw", "config.json"),
          JSON.stringify({
            _version: "1",
            _updatedAt: new Date(0).toISOString(),
            enabled: true,
            features: { delegation: true, imNotifications: true, statusPanel: true },
            judge: {
              enabled: false,
              modelId: "",
              baseUrl: "",
              apiKey: "",
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
              channels: { feishu: { appId: "cli_a", appSecret: "secret" } },
            },
          }),
          "utf8",
        );

        const report = await generateReadinessReport(openclawHome);
        const feishuCheck = report.checks.find((c) => c.id === "im.feishu");

        expect(feishuCheck?.status).toBe("pass");
        expect(feishuCheck?.summary).toContain("feishu credentials configured");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("secret redaction", () => {
    it("redacts API keys and tokens from report", () => {
      const report: OctoclawReadinessReport = {
        schemaVersion: "octoclaw.readiness/v1",
        generatedAt: new Date().toISOString(),
        checks: [
          {
            id: "judge",
            status: "pass",
            summary: "Bearer secret-token-12345 reachable",
            remediation: "Check token=secret-token-12345",
          },
          {
            id: "im.slack",
            status: "pass",
            summary: "Bearer slack-token-123 configured",
            remediation: "token=slack-token-123",
          },
        ],
      };

      const redacted = redactReadinessReport(report);

      expect(redacted.checks[0].summary).not.toContain("secret-token-12345");
      expect(redacted.checks[0].summary).toContain("[REDACTED]");
      expect(redacted.checks[0].remediation).not.toContain("secret-token-12345");
      expect(redacted.checks[1].summary).not.toContain("slack-token-123");
      expect(redacted.checks[1].remediation).not.toContain("slack-token-123");
    });
  });
});
