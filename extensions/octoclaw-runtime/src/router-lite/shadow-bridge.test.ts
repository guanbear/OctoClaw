import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { openSqliteCostEventStore } from "@octoclaw/router";
import { emitRouterLiteShadowEvent } from "./shadow-bridge.js";
import { resetSnapshotCacheForTests } from "./snapshot-loader.js";

const SNAPSHOT_ENV = "OCTOCLAW_ROUTER_SNAPSHOT_PATH";
const SHADOW_ENV = "OCTOCLAW_ROUTER_SHADOW_PATH";
const DECISIONS_ENV = "OCTOCLAW_ROUTER_DECISIONS_PATH";

type Logger = { warn: ReturnType<typeof vi.fn> };
const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

function testScenarioAbility(): Record<string, unknown> {
  const score = {
    tier: "B",
    confidence: "high",
    sources: [{ source: "operator_override", fetchedAt: "2026-05-14T00:00:00.000Z" }],
  };
  return {
    codingWorker: score,
    agenticToolTask: score,
    researchLookup: score,
    dataLogAnalysis: score,
    mainReasoning: score,
    defaultDelegate: score,
  };
}

function testModel(modelKey: string, price: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const [provider, modelName] = modelKey.split("/");
  return {
    provider,
    model: modelName,
    modelKey,
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: [],
    marketPrice: { blendedUsdPerMTok: price, confidence: "high", sources: ["test"] },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: "standard",
      confidence: "high",
      evidence: ["declared"],
      sources: ["test"],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "low",
      recentFailureRate: 0.01,
      p50FirstTokenMs: 500,
      sources: ["test"],
    },
    plan: { type: "pay_as_you_go", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: ["test"] },
    scenarioAbility: testScenarioAbility(),
    freshness: "2026-05-14T00:00:00.000Z",
    sources: ["test"],
    ...overrides,
  };
}

function writeValidSnapshot(tempDir: string, models: Record<string, unknown>[] = []): string {
  const snapshotPath = path.join(tempDir, "model-intel-snapshot.json");
  fsSync.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "snap-shadow-bridge-test",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models,
  }));
  return snapshotPath;
}

function makeDecision(): Record<string, unknown> {
  return {
    route: "delegate",
    confidence: 0.9,
    complexity: "normal",
    model_profile_final: "cliproxyapi/gpt-5.5",
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() };
}

describe("emitRouterLiteShadowEvent", () => {
  let tempDir: string;
  let originalSnapshotPath: string | undefined;
  let originalShadowPath: string | undefined;
  let originalDecisionsPath: string | undefined;
  let originalOpenclawHome: string | undefined;

  beforeEach(() => {
    resetSnapshotCacheForTests();
    tempDir = fs.mkdtempSync(path.join(osModule.tmpdir(), "router-lite-shadow-bridge-"));
    originalSnapshotPath = process.env[SNAPSHOT_ENV];
    originalShadowPath = process.env[SHADOW_ENV];
    originalDecisionsPath = process.env[DECISIONS_ENV];
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    delete process.env[SNAPSHOT_ENV];
    delete process.env[SHADOW_ENV];
    delete process.env[DECISIONS_ENV];
    delete process.env.OPENCLAW_HOME;
  });

  afterEach(() => {
    resetSnapshotCacheForTests();
    if (originalSnapshotPath === undefined) {
      delete process.env[SNAPSHOT_ENV];
    } else {
      process.env[SNAPSHOT_ENV] = originalSnapshotPath;
    }

    if (originalShadowPath === undefined) {
      delete process.env[SHADOW_ENV];
    } else {
      process.env[SHADOW_ENV] = originalShadowPath;
    }

    if (originalDecisionsPath === undefined) {
      delete process.env[DECISIONS_ENV];
    } else {
      process.env[DECISIONS_ENV] = originalDecisionsPath;
    }

    if (originalOpenclawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenclawHome;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("STB-SH-001: logs and swallows shadow IO errors", () => {
    process.env[SNAPSHOT_ENV] = writeValidSnapshot(tempDir);
    process.env[SHADOW_ENV] = "/nonexistent/dir/shadow.jsonl";
    const logger = makeLogger();

    expect(() => emitRouterLiteShadowEvent({
      sessionKey: "test",
      turnId: "t1",
      decision: makeDecision(),
      logger,
    })).not.toThrow();

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("STB-SH-002: skips silently when snapshot is missing", () => {
    process.env[SNAPSHOT_ENV] = path.join(tempDir, "missing-snapshot.json");
    const logger = makeLogger();

    expect(() => emitRouterLiteShadowEvent({
      sessionKey: "test",
      turnId: "t1",
      decision: makeDecision(),
      logger,
    })).not.toThrow();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("STB-SH-003: logs and swallows JSON serialization errors", () => {
    process.env[SNAPSHOT_ENV] = writeValidSnapshot(tempDir);
    process.env[SHADOW_ENV] = path.join(tempDir, "shadow.jsonl");
    const logger = makeLogger();
    const circularDecision: Record<string, unknown> = makeDecision();
    circularDecision.self = circularDecision;
    const circularValue: unknown = circularDecision;

    expect(() => emitRouterLiteShadowEvent({
      sessionKey: "test",
      turnId: "t1",
      decision: circularDecision,
      actualModel: circularValue as string,
      logger,
    })).not.toThrow();

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("STB-SH-004: uses local promotion decisions to mark promoted recommendations live", () => {
    process.env[SNAPSHOT_ENV] = writeValidSnapshot(tempDir, [
      testModel("openai/gpt-5.5", 20),
      testModel("deepseek/deepseek-v4", 2),
    ]);
    process.env[SHADOW_ENV] = path.join(tempDir, "shadow.jsonl");
    process.env[DECISIONS_ENV] = path.join(tempDir, "decisions.log");
    fsSync.writeFileSync(process.env[DECISIONS_ENV], `${JSON.stringify({
      ts: "2026-05-13T00:00:00.000Z",
      model: "deepseek/deepseek-v4",
      tier: "normal",
      decision: "promote",
      reason: "meets_promotion_criteria",
    })}\n`);

    emitRouterLiteShadowEvent({
      sessionKey: "test",
      turnId: "t1",
      decision: makeDecision(),
    });

    const [line] = fsSync.readFileSync(process.env[SHADOW_ENV], "utf8").trim().split("\n");
    const event = JSON.parse(line!) as Record<string, { mode?: string; recommendedModel?: string }>;
    expect(event.recommendation).toMatchObject({
      recommendedModel: "deepseek/deepseek-v4",
      mode: "live",
    });
  });

  it("STB-SH-005: passes exceeded local budget into recommendation gating", () => {
    const openclawHome = path.join(tempDir, "openclaw-home");
    process.env.OPENCLAW_HOME = openclawHome;
    process.env[SNAPSHOT_ENV] = writeValidSnapshot(tempDir, [
      testModel("openai/gpt-5.5", 20, {
        plan: { type: "subscription", quotaPressure: "low", effectiveCostBand: "free_or_sunk", sources: ["test"] },
      }),
      testModel("deepseek/deepseek-v4", 2),
    ]);
    process.env[SHADOW_ENV] = path.join(tempDir, "budget-shadow.jsonl");
    fsSync.mkdirSync(path.join(openclawHome, "octoclaw"), { recursive: true });
    fsSync.writeFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), JSON.stringify({
      budget: { monthly: 100, currency: "USD" },
    }));
    const opened = openSqliteCostEventStore({ openclawHome });
    expect(opened.status).toBe("ok");
    opened.store?.record({
      ts: "2026-05-14T00:00:00.000Z",
      model: "openai/gpt-5.5",
      costUsd: 102,
    });
    opened.store?.close();

    emitRouterLiteShadowEvent({
      sessionKey: "test",
      turnId: "t1",
      decision: makeDecision(),
    });

    const [line] = fsSync.readFileSync(process.env[SHADOW_ENV], "utf8").trim().split("\n");
    const event = JSON.parse(line!) as Record<string, { reasonCodes?: string[]; recommendedModel?: string }>;
    expect(event.recommendation).toMatchObject({
      recommendedModel: "openai/gpt-5.5",
    });
    expect(event.recommendation.reasonCodes).toContain("budget_exceeded_plan_only");
  });
});
