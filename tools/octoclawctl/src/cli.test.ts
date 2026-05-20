import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

declare const process: { env: Record<string, string | undefined> };
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { openSqliteCostEventStore } from "@octoclaw/router";
import {
  buildStabilitySlackAcceptanceCases,
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
    expect(parseCliArgs(["router", "decisions", "--since", "7d", "--format", "json"])).toMatchObject({
      command: "router",
      since: "7d",
      format: "json",
      extraArgs: ["decisions"],
    });
    expect(parseCliArgs(["router", "wizard", "--incremental"])).toMatchObject({
      command: "router",
      incremental: true,
      extraArgs: ["wizard"],
    });
    expect(parseCliArgs(["router", "cost", "report", "--period", "month"])).toMatchObject({
      command: "router",
      period: "month",
      extraArgs: ["cost", "report"],
    });
    expect(parseCliArgs(["router", "promotion", "nightly-review", "--input", "shadow.jsonl", "--format", "json"])).toMatchObject({
      command: "router",
      input: "shadow.jsonl",
      format: "json",
      extraArgs: ["promotion", "nightly-review"],
    });
    expect(parseCliArgs(["router", "model", "ban", "openai/gpt-5.5", "--for", "normal"])).toMatchObject({
      command: "router",
      forTier: "normal",
      extraArgs: ["model", "ban", "openai/gpt-5.5"],
    });
    expect(parseCliArgs(["router", "capability", "show", "openai/gpt-5-mini", "--format", "json"])).toMatchObject({
      command: "router",
      format: "json",
      extraArgs: ["capability", "show", "openai/gpt-5-mini"],
    });
    expect(parseCliArgs(["router", "wizard", "--cli", "--resume"])).toMatchObject({
      command: "router",
      cliMode: true,
      resume: true,
      extraArgs: ["wizard"],
    });
    expect(parseCliArgs(["router", "health", "list", "--cooldown-only"])).toMatchObject({
      command: "router",
      cooldownOnly: true,
      extraArgs: ["health", "list"],
    });
  });

  it("router wizard writes language and configured model source metadata", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-wizard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
      }), "utf8");

      const capture = createIo();
      const exitCode = await main(["router", "wizard", "--openclaw-home", openclawHome, "--format", "json"], {}, capture.io);

      expect(exitCode).toBe(0);
      const summary = JSON.parse(capture.stdout[0] ?? "{}");
      const saved = JSON.parse(await fs.readFile(summary.path, "utf8"));
      expect(saved).toMatchObject({
        language: "auto",
        models: {
          "openai/gpt-5.5": { source: "configured" },
        },
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router wizard consumes scripted 7-step answers and imports same-provider candidates", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-wizard-answers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const answersPath = path.join(tmpDir, "wizard-answers.json");
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }] },
            zhipu: { models: [{ id: "GLM-5.1" }] },
          },
        },
      }), "utf8");
      await fs.writeFile(answersPath, JSON.stringify({
        budget: { monthly: 125 },
        privacy: "local_only",
        language: "zh",
        restrictedModels: ["zhipu/GLM-5.1"],
        modelPlanTypes: {
          "openai/gpt-5.5": "pay_as_you_go",
          "zhipu/GLM-5.1": "subscription",
          "openai/gpt-5-mini": "pay_as_you_go",
        },
        sameProviderModels: ["openai/gpt-5-mini"],
      }), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "wizard",
        "--openclaw-home",
        openclawHome,
        "--config",
        answersPath,
        "--format",
        "json",
      ], {}, capture.io);

      expect(exitCode).toBe(0);
      const summary = JSON.parse(capture.stdout[0] ?? "{}");
      const saved = JSON.parse(await fs.readFile(summary.path, "utf8"));
      expect(summary.steps).toEqual([
        "model_scan",
        "plan_confirmation",
        "budget",
        "privacy",
        "language",
        "restricted_models",
        "same_provider_discovery",
      ]);
      expect(saved).toMatchObject({
        budget: { monthly: 125, currency: "USD" },
        privacy: "local_only",
        language: "zh",
        restrictedModels: ["zhipu/GLM-5.1"],
        openclawConfigHash: expect.any(String),
        models: {
          "openai/gpt-5.5": { planType: "pay_as_you_go", source: "configured" },
          "zhipu/GLM-5.1": { planType: "subscription", source: "configured" },
          "openai/gpt-5-mini": { planType: "pay_as_you_go", source: "same_provider_discovery" },
        },
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router wizard --cli uses the Slack wizard state machine and writes state", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-wizard-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
      }), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "wizard",
        "--cli",
        "--non-interactive",
        "--openclaw-home",
        openclawHome,
        "--format",
        "json",
      ], {}, capture.io);

      expect(exitCode).toBe(0);
      const summary = JSON.parse(capture.stdout[0] ?? "{}");
      expect(summary).toMatchObject({
        statePath: path.join(openclawHome, "octoclaw", "router-wizard.state.json"),
        configPath: path.join(openclawHome, "octoclaw", "router-wizard.json"),
        completed: true,
        step: "step-7-done",
      });
      const state = JSON.parse(await fs.readFile(summary.statePath, "utf8"));
      expect(state.schemaVersion).toBe("octoclaw.router_wizard_state/v1");
      expect(state.answers.models["openai/gpt-5.5"].planType).toBe("unknown");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router cost report includes prediction and budget status from local router config", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-cost-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const octoclawDir = path.join(openclawHome, "octoclaw");
    try {
      await fs.mkdir(octoclawDir, { recursive: true });
      await fs.writeFile(path.join(octoclawDir, "router-wizard.json"), JSON.stringify({
        schemaVersion: "octoclaw.router_wizard/v1",
        completedAt: "2026-05-14T00:00:00.000Z",
        models: { "openai/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" } },
        budget: { monthly: 100, currency: "USD" },
        privacy: "standard",
        language: "auto",
        restrictedModels: [],
        overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
      }), "utf8");
      await fs.writeFile(path.join(octoclawDir, "cost-events.jsonl"), [
        JSON.stringify({ ts: new Date().toISOString(), model: "openai/gpt-5.5", complexity: "deep", route: "delegate", costUsd: 84 }),
      ].join("\n"), "utf8");

      const capture = createIo();
      const exitCode = await main(["router", "cost", "report", "--openclaw-home", openclawHome, "--format", "json"], {}, capture.io);

      expect(exitCode).toBe(0);
      const report = JSON.parse(capture.stdout[0] ?? "{}");
      expect(report.monthEndPredictionUsd).toBeGreaterThan(0);
      expect(report.budget).toMatchObject({
        monthly: 100,
        usedPercent: 84,
        action: "warn",
        reasonCodes: ["budget_warning_80_percent"],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router cost report reads local cost.sqlite when jsonl events are absent", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-cost-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const octoclawDir = path.join(openclawHome, "octoclaw");
    try {
      await fs.mkdir(octoclawDir, { recursive: true });
      await fs.writeFile(path.join(octoclawDir, "router-wizard.json"), JSON.stringify({
        schemaVersion: "octoclaw.router_wizard/v1",
        completedAt: "2026-05-14T00:00:00.000Z",
        models: { "openai/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" } },
        budget: { monthly: 100, currency: "USD" },
        privacy: "standard",
        language: "auto",
        restrictedModels: [],
        overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
      }), "utf8");
      const opened = openSqliteCostEventStore({ dbPath: path.join(octoclawDir, "cost.sqlite") });
      expect(opened.status).toBe("ok");
      opened.store?.record({
        ts: new Date().toISOString(),
        model: "openai/gpt-5.5",
        complexity: "deep",
        route: "delegate",
        costUsd: 64,
      });
      opened.store?.close();

      const capture = createIo();
      const exitCode = await main(["router", "cost", "report", "--openclaw-home", openclawHome, "--format", "json"], {}, capture.io);

      expect(exitCode).toBe(0);
      const report = JSON.parse(capture.stdout[0] ?? "{}");
      expect(report.totalUsd).toBe(64);
      expect(report.byModel["openai/gpt-5.5"]).toMatchObject({ totalUsd: 64, percent: 100 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router promotion review evaluates shadow samples and writes decisions log", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const octoclawDir = path.join(openclawHome, "octoclaw");
    const routerLiteDir = path.join(octoclawDir, "router-lite");
    const shadowPath = path.join(routerLiteDir, "shadow.jsonl");
    try {
      await fs.mkdir(routerLiteDir, { recursive: true });
      await fs.writeFile(path.join(octoclawDir, "router-wizard.json"), JSON.stringify({
        schemaVersion: "octoclaw.router_wizard/v1",
        completedAt: "2026-05-14T00:00:00.000Z",
        models: {
          "openai/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" },
          "openai/gpt-5-mini": { planType: "pay_as_you_go", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" },
        },
        privacy: "standard",
        language: "auto",
        restrictedModels: [],
        overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
      }), "utf8");
      const events = Array.from({ length: 35 }, (_, index) => JSON.stringify({
        ts: new Date(Date.UTC(2026, 4, 14, 0, index)).toISOString(),
        actualModel: "openai/gpt-5.5",
        recommendedModel: "openai/gpt-5-mini",
        promotionState: "shadow",
        judge: { complexity: "normal" },
        outcome: { success: true, costUsd: 1 },
        recommendation: { expectedSuccess: true, expectedCostUsd: 0.8 },
      })).join("\n");
      await fs.writeFile(shadowPath, events, "utf8");

      const capture = createIo();
      const exitCode = await main(["router", "promotion", "review", "--openclaw-home", openclawHome, "--input", shadowPath, "--format", "json"], {}, capture.io);

      expect(exitCode).toBe(0);
      const result = JSON.parse(capture.stdout[0] ?? "{}");
      expect(result.decisions).toEqual([
        expect.objectContaining({ model: "openai/gpt-5-mini", tier: "normal", decision: "promote" }),
      ]);
      expect(await fs.readFile(path.join(routerLiteDir, "decisions.log"), "utf8")).toContain("openai/gpt-5-mini");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router promotion nightly-review reports lightweight failure cost and ignored-reason signals", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-nightly-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const routerLiteDir = path.join(openclawHome, "workspace", "tmp", "octopus", "router-lite");
    const shadowPath = path.join(routerLiteDir, "shadow.jsonl");
    try {
      await fs.mkdir(routerLiteDir, { recursive: true });
      const events = Array.from({ length: 25 }, (_, index) => JSON.stringify({
        ts: new Date(Date.UTC(2026, 4, 14, 0, index)).toISOString(),
        actualModel: "openai/gpt-5.5",
        recommendation: {
          recommendedModel: "openai/gpt-5-mini",
          reasonCodes: index % 2 === 0 ? ["ignored_low_confidence"] : [],
          expectedSuccess: index >= 8,
          expectedCostUsd: index === 24 ? 2 : 0.75,
        },
        judge: { complexity: "normal" },
        outcome: { success: index >= 7, costUsd: 1 },
      })).join("\n");
      await fs.writeFile(shadowPath, events, "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "promotion",
        "nightly-review",
        "--openclaw-home",
        openclawHome,
        "--input",
        shadowPath,
        "--format",
        "json",
      ], {}, capture.io);

      expect(exitCode).toBe(0);
      const review = JSON.parse(capture.stdout[0] ?? "{}");
      expect(review.failureRates["openai/gpt-5-mini"]).toBeGreaterThan(0.20);
      expect(review.ignoredReasonCounts.ignored_low_confidence).toBe(13);
      expect(review.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: "openai/gpt-5-mini", reason: "consecutive_failures_or_failure_rate" }),
      ]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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
    expect(capture.stdout[0]).toContain("octoclawctl init");
  });

  it("parses standalone init flags", () => {
    expect(parseCliArgs(["init", "--non-interactive", "--lang", "en"])).toMatchObject({
      command: "init",
      nonInteractive: true,
      lang: "en",
    });
  });

  it("prints package version", async () => {
    const capture = createIo();
    const exitCode = await main(["--version"], {}, capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toEqual(["0.6.0"]);
    expect(capture.stderr).toEqual([]);
  });

  it("runs init non-interactively without runtime data", async () => {
    const capture = createIo();
    const exitCode = await main(["init", "--non-interactive", "--lang", "en"], {}, capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Initialization complete");
    expect(capture.stdout[0]).not.toMatch(/[\u3400-\u9fff]/u);
    expect(capture.stderr).toEqual([]);
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

  it("runOctoClawCtl library function still works", async () => {
    const output = await runOctoClawCtl("status", createRecord(), "text");

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
      await fs.mkdir(path.join(openclawHome, "octoclaw", "router-lite"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "octoclaw", "router-lite", "model-health.jsonl"), `${JSON.stringify({
        schemaVersion: "octoclaw.router.health_event/v1",
        ts: Date.now() - 1000,
        modelKey: "cliproxyapi/gpt-5.5",
        source: "runtime",
        success: false,
        latencyMs: 2500,
        errorCode: "429",
      })}\n`, "utf8");
      await fs.writeFile(fakeOpenClaw, [
        "#!/bin/sh",
        "if [ \"$*\" = \"models list --json\" ]; then",
        "  echo 'config warning before json'",
        "  echo '{\"models\":[{\"key\":\"cliproxyapi/gpt-5.5\",\"input\":[\"text\"],\"contextWindow\":1000000,\"available\":true,\"tags\":[\"configured\"],\"missing\":false}]}'",
        "elif [ \"$*\" = \"models fallbacks list --json\" ]; then",
        "  echo '{\"fallbacks\":[\"cliproxyapi/gpt-5.5\",\"zai/glm-4.7\"]}'",
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
      expect(refreshSummary).toMatchObject({ configured: 1 });
      expect(refreshSummary.health).toMatchObject({ models: 1, cooldown: 1 });
      expect(refreshSummary.proposalOnly).toBeGreaterThanOrEqual(4);
      expect(refreshSummary.models).toBeGreaterThanOrEqual(5);

      const snapshot = JSON.parse(await fs.readFile(path.join(outputDir, "model-intel-snapshot.json"), "utf8"));
      expect(snapshot.models.map((model: { modelKey: string }) => model.modelKey)).toEqual(expect.arrayContaining([
        "cliproxyapi/gpt-5.5",
        "cliproxyapi/gpt-5.5-mini",
        "openai/gpt-5-mini",
      ]));
      expect(snapshot.sourceStatus).toContainEqual({ source: "packaged_model_intel", status: "ok" });
      expect(snapshot.sourceStatus).toContainEqual({ source: "router_health_snapshot", status: "ok" });
      expect(snapshot.sourceStatus).toContainEqual({ source: "openclaw_native_fallbacks", status: "ok" });
      expect(snapshot.nativeFallbackOrder).toEqual(["cliproxyapi/gpt-5.5", "zai/glm-4.7"]);
      expect(snapshot.models.find((model: { modelKey: string }) => model.modelKey === "cliproxyapi/gpt-5.5")).toMatchObject({
        health: {
          cooldown: true,
          recentFailureRate: 1,
          p95LatencyMs: 2500,
        },
      });

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

  it("router capability refresh, list, show, and lookup use external source adapters", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tempDir, "home");
    const outputDir = path.join(tempDir, "out");
    try {
      await fs.mkdir(outputDir, { recursive: true });

      const refreshCapture = createIo();
      const refreshExitCode = await main([
        "router",
        "capability",
        "refresh",
        "--openclaw-home",
        openclawHome,
        "--output-dir",
        outputDir,
        "--format",
        "json",
      ], {
        OCTOCLAW_ROUTER_CAPABILITY_SOURCES_JSON: JSON.stringify({
          openrouter: {
            data: [{
              id: "openai/gpt-5-mini",
              context_length: 128000,
              pricing: { prompt: "0.000001", completion: "0.000004" },
              supported_parameters: ["tools", "response_format"],
            }],
          },
          modelsDev: {},
          litellm: {},
        }),
      }, refreshCapture.io);
      expect(refreshExitCode).toBe(0);
      const summary = JSON.parse(refreshCapture.stdout[0] ?? "{}");
      expect(summary).toMatchObject({
        sourceStatus: expect.arrayContaining([
          { source: "packaged_leaderboard", status: "ok" },
          { source: "openrouter", status: "ok" },
          { source: "models.dev", status: "ok" },
          { source: "litellm", status: "ok" },
        ]),
      });
      expect(summary.models).toBeGreaterThanOrEqual(1);

      const snapshotPath = path.join(outputDir, "model-intel-snapshot.json");
      const listCapture = createIo();
      const listExitCode = await main([
        "router",
        "capability",
        "list",
        "--openclaw-home",
        openclawHome,
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {}, listCapture.io);
      expect(listExitCode).toBe(0);
      expect(JSON.parse(listCapture.stdout[0] ?? "{}").models).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelKey: "openai/gpt-5-mini", provider: "openai" }),
      ]));

      const showCapture = createIo();
      const showExitCode = await main([
        "router",
        "capability",
        "show",
        "openai/gpt-5-mini",
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {}, showCapture.io);
      expect(showExitCode).toBe(0);
      expect(JSON.parse(showCapture.stdout[0] ?? "{}")).toMatchObject({
        modelKey: "openai/gpt-5-mini",
        marketPrice: { inputUsdPerMTok: 1, outputUsdPerMTok: 4 },
        capability: { contextWindow: 128000, toolUse: "yes", structuredOutput: "yes" },
      });

      const lookupCapture = createIo();
      const lookupExitCode = await main([
        "router",
        "capability",
        "lookup",
        "openai/gpt-5-mini",
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {}, lookupCapture.io);
      expect(lookupExitCode).toBe(0);
      expect(JSON.parse(lookupCapture.stdout[0] ?? "{}")).toMatchObject({
        model: "openai/gpt-5-mini",
        ok: true,
        reason: "known_available",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router capability probe records proposal probe success without configuring proxy model", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tempDir, "home");
    const outputDir = path.join(tempDir, "out");
    const snapshotPath = path.join(outputDir, "model-intel-snapshot.json");
    try {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(path.join(openclawHome, "octoclaw"), { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "https://clip.example.test/v1",
              apiKey: "clip-secret",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      }, null, 2), "utf8");
      await fs.writeFile(path.join(openclawHome, "octoclaw", "router-wizard.json"), JSON.stringify({
        schemaVersion: "octoclaw.router_wizard/v1",
        completedAt: "2026-05-15T00:00:00.000Z",
        models: {
          "cliproxyapi/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-15T00:00:00.000Z", source: "configured" },
          "cliproxyapi/gpt-5-mini": {
            planType: "pay_as_you_go",
            configuredAt: "2026-05-15T00:00:00.000Z",
            source: "same_provider_discovery",
            state: "proposal_candidate",
          },
        },
        privacy: "standard",
        language: "auto",
        restrictedModels: [],
        overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
      }, null, 2), "utf8");
      await fs.writeFile(snapshotPath, JSON.stringify({
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "snapshot",
        generatedAt: "2026-05-15T00:00:00.000Z",
        sourceStatus: [],
        models: [
          {
            provider: "cliproxyapi",
            model: "gpt-5-mini",
            modelKey: "cliproxyapi/gpt-5-mini",
            configured: false,
            proposalOnly: true,
            available: "yes",
            tags: [],
            marketPrice: { blendedUsdPerMTok: 0.2, confidence: "medium", sources: ["test"] },
            capability: { codingTier: "mini", confidence: "medium", evidence: ["declared"], sources: ["test"], input: ["text"], toolUse: "yes", structuredOutput: "yes", reasoning: "yes", promptCache: "unknown" },
            health: { available: "yes", cooldown: false, quotaPressure: "unknown", sources: [] },
            plan: { type: "unknown", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: [] },
            sources: ["test"],
          },
        ],
      }, null, 2), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "capability",
        "probe",
        "cliproxyapi/gpt-5-mini",
        "--openclaw-home",
        openclawHome,
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {
        OCTOCLAW_ROUTER_PROBE_MOCK_JSON: JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      }, capture.io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(capture.stdout[0] ?? "{}")).toMatchObject({ ok: true, modelKey: "cliproxyapi/gpt-5-mini" });
      const wizard = JSON.parse(await fs.readFile(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8"));
      expect(wizard.models["cliproxyapi/gpt-5-mini"]).toMatchObject({
        source: "same_provider_discovery",
        state: "probed_ok",
      });
      expect(typeof wizard.models["cliproxyapi/gpt-5-mini"].lastProbeOkAt).toBe("string");
      const openclaw = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(openclaw.models.providers.cliproxyapi.models).toEqual([{ id: "gpt-5.5" }]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router capability probe canaries same-provider proposals through a temporary OpenClaw config", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-probe-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tempDir, "home");
    const outputDir = path.join(tempDir, "out");
    const snapshotPath = path.join(outputDir, "model-intel-snapshot.json");
    const markerPath = path.join(tempDir, "probe-marker.json");
    const fakeOpenClawPath = path.join(tempDir, "bin", "openclaw");
    try {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(path.join(openclawHome, "octoclaw"), { recursive: true });
      await fs.mkdir(path.dirname(fakeOpenClawPath), { recursive: true });
      await fs.writeFile(fakeOpenClawPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.OPENCLAW_HOME;
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(home, "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const models = config.models.providers.cliproxyapi.models.map((model) => model.id || model);
fs.writeFileSync(process.env.PROBE_MARKER, JSON.stringify({ home, configPath, models }, null, 2));
if (!models.includes("gpt-5-mini")) {
  console.error("Unknown model: cliproxyapi/gpt-5-mini");
  process.exit(1);
}
console.log(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
`, "utf8");
      await runTestCommand("chmod", ["755", fakeOpenClawPath]);
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "https://clip.example.test/v1",
              apiKey: "clip-secret",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      }, null, 2), "utf8");
      await fs.writeFile(path.join(openclawHome, "octoclaw", "router-wizard.json"), JSON.stringify({
        schemaVersion: "octoclaw.router_wizard/v1",
        completedAt: "2026-05-15T00:00:00.000Z",
        models: {
          "cliproxyapi/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-15T00:00:00.000Z", source: "configured" },
          "cliproxyapi/gpt-5-mini": {
            planType: "pay_as_you_go",
            configuredAt: "2026-05-15T00:00:00.000Z",
            source: "same_provider_discovery",
            state: "proposal_candidate",
          },
        },
        privacy: "standard",
        language: "auto",
        restrictedModels: [],
        overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
      }, null, 2), "utf8");
      await fs.writeFile(snapshotPath, JSON.stringify({
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "snapshot",
        generatedAt: "2026-05-15T00:00:00.000Z",
        sourceStatus: [],
        models: [
          {
            provider: "cliproxyapi",
            model: "gpt-5-mini",
            modelKey: "cliproxyapi/gpt-5-mini",
            configured: false,
            proposalOnly: true,
            available: "yes",
            tags: [],
            marketPrice: { blendedUsdPerMTok: 0.2, confidence: "medium", sources: ["test"] },
            capability: { codingTier: "mini", confidence: "medium", evidence: ["declared"], sources: ["test"], input: ["text"], toolUse: "yes", structuredOutput: "yes", reasoning: "yes", promptCache: "unknown" },
            health: { available: "yes", cooldown: false, quotaPressure: "unknown", sources: [] },
            plan: { type: "unknown", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: [] },
            sources: ["test"],
          },
        ],
      }, null, 2), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "capability",
        "probe",
        "cliproxyapi/gpt-5-mini",
        "--openclaw-home",
        openclawHome,
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {
        OPENCLAW_BIN: fakeOpenClawPath,
        PROBE_MARKER: markerPath,
      }, capture.io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(capture.stdout[0] ?? "{}")).toMatchObject({ ok: true, modelKey: "cliproxyapi/gpt-5-mini" });
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      expect(marker.home).not.toBe(openclawHome);
      expect(marker.configPath).toBe(path.join(marker.home, "openclaw.json"));
      expect(marker.models).toEqual([{ id: "gpt-5.5" }, { id: "gpt-5-mini" }].map((model) => model.id));
      const realConfig = JSON.parse(await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8"));
      expect(realConfig.models.providers.cliproxyapi.models).toEqual([{ id: "gpt-5.5" }]);
      const wizard = JSON.parse(await fs.readFile(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8"));
      expect(wizard.models["cliproxyapi/gpt-5-mini"].state).toBe("probed_ok");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router capability show reports stale data age in text output", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const snapshotPath = path.join(tempDir, "model-intel-snapshot.json");
    try {
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify({
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "stale-test",
        generatedAt: "2026-05-14T00:00:00.000Z",
        sourceStatus: [],
        models: [{
          provider: "openai",
          model: "gpt-5-mini",
          modelKey: "openai/gpt-5-mini",
          configured: false,
          available: "yes",
          proposalOnly: true,
          tags: [],
          marketPrice: { confidence: "unknown", sources: [] },
          capability: {
            input: ["text"],
            toolUse: "yes",
            structuredOutput: "yes",
            reasoning: "unknown",
            promptCache: "unknown",
            codingTier: "mini",
            confidence: "medium",
            evidence: ["declared"],
            sources: ["models.dev"],
          },
          health: { available: "yes", cooldown: false, quotaPressure: "unknown", sources: [] },
          plan: { type: "unknown", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: [] },
          freshness: "2026-01-01T00:00:00.000Z",
          sources: ["models.dev"],
        }],
      }), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "capability",
        "show",
        "openai/gpt-5-mini",
        "--input",
        snapshotPath,
      ], {}, capture.io);

      expect(exitCode).toBe(0);
      expect(capture.stdout[0]).toContain("data very_stale");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router capability snapshot show reports snapshot metadata", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const snapshotPath = path.join(tempDir, "model-intel-snapshot.json");
    try {
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify({
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "snapshot-meta-test",
        generatedAt: "2026-05-14T00:00:00.000Z",
        sourceStatus: [
          { source: "packaged_leaderboard", status: "ok" },
          { source: "openrouter", status: "error", detail: "offline" },
        ],
        models: [{
          provider: "openai",
          model: "gpt-5-mini",
          modelKey: "openai/gpt-5-mini",
          configured: false,
          available: "yes",
          proposalOnly: true,
          tags: [],
          marketPrice: { confidence: "unknown", sources: [] },
          capability: {
            input: ["text"],
            toolUse: "yes",
            structuredOutput: "yes",
            reasoning: "unknown",
            promptCache: "unknown",
            codingTier: "mini",
            confidence: "medium",
            evidence: ["declared"],
            sources: ["models.dev"],
          },
          health: { available: "yes", cooldown: false, quotaPressure: "unknown", sources: [] },
          plan: { type: "unknown", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: [] },
          freshness: "2026-05-14T00:00:00.000Z",
          sources: ["models.dev"],
        }],
      }), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "capability",
        "snapshot",
        "show",
        "--input",
        snapshotPath,
      ], {}, capture.io);

      expect(exitCode).toBe(0);
      expect(capture.stdout[0]).toContain("Capability snapshot: snapshot-meta-test");
      expect(capture.stdout[0]).toContain("models=1");
      expect(capture.stdout[0]).toContain("openrouter:error");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router decisions lists filtered promotion audit records", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-decisions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const decisionsDir = path.join(openclawHome, "octoclaw", "router-lite");
    try {
      await fs.mkdir(decisionsDir, { recursive: true });
      await fs.writeFile(path.join(decisionsDir, "decisions.log"), [
        JSON.stringify({ ts: "2026-05-01T00:00:00.000Z", model: "a/old", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" }),
        JSON.stringify({ ts: new Date().toISOString(), model: "deepseek/deepseek-v4", tier: "normal", decision: "reject", reason: "no_cost_benefit" }),
      ].join("\n"), "utf8");

      const capture = createIo();
      const exitCode = await main(["router", "decisions", "--since", "7d", "--openclaw-home", openclawHome], {}, capture.io);

      expect(exitCode).toBe(0);
      expect(capture.stdout[0]).toContain("deepseek/deepseek-v4");
      expect(capture.stdout[0]).not.toContain("a/old");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("router health commands aggregate, list, show, and suggest fallback updates", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tempDir, "home");
    try {
      const healthDir = path.join(openclawHome, "octoclaw", "router-lite");
      await fs.mkdir(healthDir, { recursive: true });
      const jsonlPath = path.join(healthDir, "model-health.jsonl");
      await fs.writeFile(jsonlPath, [
        JSON.stringify({ schemaVersion: "octoclaw.router.health_event/v1", ts: Date.now() - 1000, modelKey: "cliproxyapi/gpt-5.5", source: "runtime", success: false, errorCode: "429", latencyMs: 1000 }),
        JSON.stringify({ schemaVersion: "octoclaw.router.health_event/v1", ts: Date.now() - 500, modelKey: "zai/glm-4.7", source: "runtime", success: true, latencyMs: 700 }),
      ].join("\n") + "\n", "utf8");

      const aggregateCapture = createIo();
      expect(await main(["router", "health", "aggregate", "--openclaw-home", openclawHome, "--format", "json"], {}, aggregateCapture.io)).toBe(0);
      expect(JSON.parse(aggregateCapture.stdout[0] ?? "{}")).toMatchObject({ models: 2, cooldown: 1 });

      const listCapture = createIo();
      expect(await main(["router", "health", "list", "--openclaw-home", openclawHome, "--format", "json"], {}, listCapture.io)).toBe(0);
      expect(JSON.parse(listCapture.stdout[0] ?? "{}").models).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelKey: "cliproxyapi/gpt-5.5", cooldown: true }),
      ]));

      const cooldownOnlyCapture = createIo();
      expect(await main(["router", "health", "list", "--cooldown-only", "--openclaw-home", openclawHome, "--format", "json"], {}, cooldownOnlyCapture.io)).toBe(0);
      expect(JSON.parse(cooldownOnlyCapture.stdout[0] ?? "{}").models.map((model: { modelKey: string }) => model.modelKey)).toEqual(["cliproxyapi/gpt-5.5"]);

      const showCapture = createIo();
      expect(await main(["router", "health", "show", "cliproxyapi/gpt-5.5", "--openclaw-home", openclawHome, "--format", "json"], {}, showCapture.io)).toBe(0);
      expect(JSON.parse(showCapture.stdout[0] ?? "{}")).toMatchObject({
        modelKey: "cliproxyapi/gpt-5.5",
        cooldown: true,
        cooldownReason: "rate_limit_429",
      });

      const suggestCapture = createIo();
      expect(await main(["router", "health", "suggest-fallbacks", "--openclaw-home", openclawHome, "--format", "json"], {}, suggestCapture.io)).toBe(0);
      expect(JSON.parse(suggestCapture.stdout[0] ?? "{}").suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelKey: "cliproxyapi/gpt-5.5", reason: "rate_limit_429" }),
      ]));

      const overrideDir = path.join(tempDir, "override");
      await fs.mkdir(overrideDir, { recursive: true });
      const overridePath = path.join(overrideDir, "custom-health.jsonl");
      await fs.writeFile(overridePath, `${JSON.stringify({ schemaVersion: "octoclaw.router.health_event/v1", ts: Date.now() - 1000, modelKey: "override/model", source: "runtime", success: false, errorCode: "PROBE_HTTP_ERROR", latencyMs: 1000 })}\n`, "utf8");
      const overrideCapture = createIo();
      expect(await main(
        ["router", "health", "list", "--openclaw-home", openclawHome, "--format", "json"],
        { OCTOCLAW_ROUTER_HEALTH_PATH: overridePath },
        overrideCapture.io,
      )).toBe(0);
      expect(JSON.parse(overrideCapture.stdout[0] ?? "{}").models.map((model: { modelKey: string }) => model.modelKey)).toEqual(["override/model"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("router capability probe lets OpenClaw native runner decide provider availability", async () => {
    const tempDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `router-capability-probe-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tempDir, "home");
    const outputDir = path.join(tempDir, "out");
    const snapshotPath = path.join(outputDir, "model-intel-snapshot.json");
    try {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify({
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "snapshot",
        generatedAt: "2026-05-15T00:00:00.000Z",
        sourceStatus: [],
        models: [],
      }, null, 2), "utf8");

      const capture = createIo();
      const exitCode = await main([
        "router",
        "capability",
        "probe",
        "cliproxyapi/gpt-5-mini",
        "--openclaw-home",
        openclawHome,
        "--input",
        snapshotPath,
        "--format",
        "json",
      ], {
        OCTOCLAW_ROUTER_PROBE_MOCK_JSON: JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      }, capture.io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(capture.stdout[0] ?? "{}")).toMatchObject({ ok: true, modelKey: "cliproxyapi/gpt-5-mini" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
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
      expect(openclawConfig.channels.slack.streaming).toEqual({ mode: "partial", nativeTransport: true });
      expect(openclawConfig.channels.slack.nativeStreaming).toBe(true);
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

  describe("stability smoke v2 scheduling", () => {
    it("SSV2-050: CLI parses stability post-deploy command", () => {
      expect(parseCliArgs(["stability", "post-deploy", "--output-dir", "/tmp/stab"])).toMatchObject({
        command: "stability",
        stabilitySubcommand: "post-deploy",
        outputDir: "/tmp/stab",
      });
    });

    it("SSV2-050: CLI parses stability nightly command", () => {
      expect(parseCliArgs(["stability", "nightly", "--output-dir", "/tmp/stab"])).toMatchObject({
        command: "stability",
        stabilitySubcommand: "nightly",
        outputDir: "/tmp/stab",
      });
    });

    it("SSV2-050: CLI parses stability full with --cadence", () => {
      expect(parseCliArgs(["stability", "full", "--output-dir", "/tmp/stab", "--cadence", "3d"])).toMatchObject({
        command: "stability",
        stabilitySubcommand: "full",
        outputDir: "/tmp/stab",
        cadence: "3d",
      });
    });

    it("SSV2-051: live stability cases preserve the configured Slack mention trigger", () => {
      const cases = buildStabilitySlackAcceptanceCases([
        {
          id: "configured",
          kind: "plain_chat",
          prompt: "<@U0ARU7EKGCQ> 在吗",
        },
      ]);

      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((item) => item.prompt?.startsWith("<@U0ARU7EKGCQ> "))).toBe(true);
    });

    it("SSV2-051: live stability cases skip replay-only assertions when replayPath is absent", () => {
      const cases = buildStabilitySlackAcceptanceCases([], { hasReplayPath: false });

      expect(cases.find((item) => item.id === "footer_truth.current_model")?.expectReplay).toBeUndefined();
      expect(cases.find((item) => item.id === "delegate_core.native_final")?.expectReplay).toBeUndefined();
    });

    it("SSV2-051: footer truth uses the visible footer while delegate final waits for a real summary", () => {
      const cases = buildStabilitySlackAcceptanceCases([], { hasReplayPath: true });

      expect(cases.find((item) => item.id === "footer_truth.current_model")?.expectReplay).toBeUndefined();
      expect(cases.find((item) => item.id === "delegate_core.native_final")?.ackTimeoutMs).toBe(180_000);
      expect(cases.find((item) => item.id === "delegate_core.native_final")?.allowFastFinalAck).toBe(true);
      expect(cases.find((item) => item.id === "delegate_core.native_final")?.expectFinalAll).toEqual([
        "Gateway|OpenClaw|OctoClaw|readiness",
        "状态|摘要|结论",
      ]);
    });

    it("SSV2-010/SSV2-011: post-deploy live pack includes read-only status and rejects bare infrastructure errors", () => {
      const cases = buildStabilitySlackAcceptanceCases([], { hasReplayPath: true });
      const ids = cases.map((item) => item.id);

      expect(ids).toEqual([
        "reply_core.simple_chat",
        "streaming_core.long_reply",
        "delegate_core.native_final",
        "footer_truth.current_model",
        "status_core.read_only",
      ]);

      const statusCase = cases.find((item) => item.id === "status_core.read_only");
      expect(statusCase).toMatchObject({
        kind: "plain_chat",
        finalRequired: true,
        noSpawnExpected: true,
        expectFooter: { route: "reply" },
        expectFinal: ["octoclaw: route=reply"],
      });
      expect(statusCase?.prompt).toContain("只读");

      for (const liveCase of cases) {
        expect(liveCase.rejectFinal).toEqual(expect.arrayContaining([
          "402 status code \\(no body\\)",
          "429 status code \\(no body\\)",
          "Previous run is still shutting down",
        ]));
      }
    });

    it("SSV2-053: full acceptance cadence defaults to 3d", async () => {
      const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-full-cadence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const outputDir = path.join(tmpDir, "reports");
      try {
        await fs.mkdir(outputDir, { recursive: true });
        const capture = createIo();
        const exitCode = await main(
          ["stability", "full", "--output-dir", outputDir],
          {},
          capture.io,
        );

        expect(exitCode).toBe(0);
        expect(capture.stdout[0]).toContain("gate=");
        expect(capture.stdout[0]).toContain("Report:");

        const artifactDir = path.join(outputDir, "stability-smoke-v2");
        const entries = await fs.readdir(artifactDir, { withFileTypes: true });
        const reportFiles = entries.filter((e) => e.name.endsWith("-stability-report.json")).map((e) => e.name);
        expect(reportFiles.length).toBe(1);

        const report = JSON.parse(await fs.readFile(path.join(artifactDir, reportFiles[0]), "utf8"));
        expect(report.schemaVersion).toBe("octoclaw.stability_smoke.report/v2");
        expect(report.runKind).toBe("full_3d");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("SSV2-051: missing Slack env skips live cases but runs non-live lanes", async () => {
      const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-no-slack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const outputDir = path.join(tmpDir, "reports");
      try {
        await fs.mkdir(outputDir, { recursive: true });
        const capture = createIo();
        const exitCode = await main(
          ["stability", "nightly", "--output-dir", outputDir],
          {},
          capture.io,
        );

        expect(exitCode).toBe(0);
        expect(capture.stdout[0]).toContain("Skipped live: missing_slack_env");

        const artifactDir = path.join(outputDir, "stability-smoke-v2");
        const entries = await fs.readdir(artifactDir, { withFileTypes: true });
        const reportFiles = entries.filter((e) => e.name.endsWith("-stability-report.json")).map((e) => e.name);
        expect(reportFiles.length).toBe(1);

        const report = JSON.parse(await fs.readFile(path.join(artifactDir, reportFiles[0]), "utf8"));
        const liveLane = report.lanes.find((lane: { name: string }) => lane.name === "slack_delivery");
        expect(liveLane).toBeDefined();
        expect(liveLane.failureCodes).toContain("environment_unhealthy");

        const nonLiveLanes = report.lanes.filter((lane: { name: string }) => lane.name !== "slack_delivery");
        expect(nonLiveLanes.length).toBeGreaterThan(0);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("SSV2-052: report paths are written and report is sanitized", async () => {
      const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const outputDir = path.join(tmpDir, "reports");
      try {
        await fs.mkdir(outputDir, { recursive: true });
        const capture = createIo();
        const exitCode = await main(
          ["stability", "post-deploy", "--output-dir", outputDir],
          {},
          capture.io,
        );

        expect(exitCode).toBe(0);
        const output = capture.stdout[0];
        expect(output).toContain("Report:");
        expect(output).toContain("-stability-report.json");
        expect(output).toContain("Markdown:");
        expect(output).toContain("-stability-report.md");
        expect(output).toContain("Summary:");
        expect(output).toContain("-stability-summary.txt");

        const artifactDir = path.join(outputDir, "stability-smoke-v2");
        const entries = await fs.readdir(artifactDir, { withFileTypes: true });
        const jsonFiles = entries.filter((e) => e.name.endsWith("-stability-report.json")).map((e) => e.name);
        const mdFiles = entries.filter((e) => e.name.endsWith("-stability-report.md")).map((e) => e.name);
        const summaryFiles = entries.filter((e) => e.name.endsWith("-stability-summary.txt")).map((e) => e.name);
        expect(jsonFiles.length).toBe(1);
        expect(mdFiles.length).toBe(1);
        expect(summaryFiles.length).toBe(1);

        const report = JSON.parse(await fs.readFile(path.join(artifactDir, jsonFiles[0]), "utf8"));
        expect(report.schemaVersion).toBe("octoclaw.stability_smoke.report/v2");
        expect(report.runKind).toBe("post_deploy");
        expect(report.generatedAt).toBeTruthy();
        expect(report.artifactDir).toBe(artifactDir);

        const reportText = JSON.stringify(report);
        expect(reportText).not.toContain("xoxb-");
        expect(reportText).not.toContain("sk-");
        const summary = await fs.readFile(path.join(artifactDir, summaryFiles[0]), "utf8");
        expect(summary).toContain("Stability Smoke v2");
        expect(summary).not.toContain("xoxb-");
        expect(summary).not.toContain("sk-");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("SSV2-054: review-latest reads and classifies failures", async () => {
      const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const outputDir = path.join(tmpDir, "reports");
      try {
        await fs.mkdir(path.join(outputDir, "stability-smoke-v2"), { recursive: true });

        await fs.writeFile(path.join(outputDir, "stability-smoke-v2", "2026-05-20-stability-report.json"), JSON.stringify({
          schemaVersion: "octoclaw.stability_smoke.report/v2",
          generatedAt: "2026-05-20T12:00:00.000Z",
          runKind: "nightly",
          overallGate: "fail",
          lanes: [{ name: "slack_delivery", gate: "fail", caseIds: ["reply_core.simple_chat"], failureCodes: ["delegate_footer_without_spawn"] }],
          failures: [{ code: "delegate_footer_without_spawn", severity: "blocker", caseId: "delegate_core.native_final", mode: "live_slack" }],
          artifactDir: path.join(outputDir, "stability-smoke-v2"),
        }), "utf8");

        const capture = createIo();
        const exitCode = await main(
          ["stability", "review-latest", "--output-dir", outputDir],
          {},
          capture.io,
        );

        expect(exitCode).toBe(0);
        expect(capture.stdout[0]).toContain("Gate: fail");
        expect(capture.stdout[0]).toContain("delegate_footer_without_spawn");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("SSV2-054: fix-draft produces guarded summary without committing", async () => {
      const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-fix-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const outputDir = path.join(tmpDir, "reports");
      try {
        await fs.mkdir(path.join(outputDir, "stability-smoke-v2"), { recursive: true });

        await fs.writeFile(path.join(outputDir, "stability-smoke-v2", "2026-05-20-stability-report.json"), JSON.stringify({
          schemaVersion: "octoclaw.stability_smoke.report/v2",
          generatedAt: "2026-05-20T12:00:00.000Z",
          runKind: "nightly",
          overallGate: "fail",
          lanes: [{ name: "delegate_contract", gate: "fail", caseIds: ["delegate_core.native_final"], failureCodes: ["delegate_footer_without_spawn"] }],
          failures: [{ code: "delegate_footer_without_spawn", severity: "blocker", caseId: "delegate_core.native_final", mode: "live_slack", classification: "runtime_bug" }],
          artifactDir: path.join(outputDir, "stability-smoke-v2"),
        }), "utf8");

        const capture = createIo();
        const exitCode = await main(
          ["stability", "fix-draft", "--output-dir", outputDir],
          {},
          capture.io,
        );

        expect(exitCode).toBe(0);
        expect(capture.stdout[0]).toContain("Fix-draft:");
        expect(capture.stdout[0]).toContain("runtime_bug");
        expect(capture.stdout[0]).toContain("delegate_core.native_final");
        expect(capture.stdout[0]).toContain("Do not commit, push, deploy, restart Gateway, or mutate OpenClaw config");
        expect(capture.stdout[0]).not.toContain("git commit");
        expect(capture.stdout[0]).not.toContain("git push");
        expect(capture.stdout[0]).not.toContain("gateway restart");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects unknown stability subcommand", () => {
      expect(() => parseCliArgs(["stability", "bogus"])).toThrow("Unknown stability subcommand: bogus");
    });

    it("requires stability subcommand", () => {
      expect(() => parseCliArgs(["stability"])).toThrow("stability requires a subcommand");
    });

    it("requires --output-dir for run subcommands", () => {
      expect(() => parseCliArgs(["stability", "post-deploy"])).toThrow("requires --output-dir");
    });
  });
});
