import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateBudget,
  generateCostReport,
  openSqliteCostEventStore,
} from "../../cost/index.js";
import type { ModelIntelLite, ModelIntelSnapshot, RouterLiteRequest, ScenarioAbilityLite } from "../../decision/contracts.js";
import { selectShadowRecommendation } from "../../decision/shadow-selector.js";
import { buildPromotionState } from "../../promotion/index.js";
import { createWizardConfig } from "../../wizard/index.js";

const FRESH_TEST_TIMESTAMP = new Date().toISOString();

const fs = fsSync as unknown as {
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

function scenarioAbility(): ScenarioAbilityLite {
  const score = {
    tier: "B" as const,
    confidence: "high" as const,
    sources: [{ source: "operator_override" as const, fetchedAt: FRESH_TEST_TIMESTAMP }],
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

function model(modelKey: string, price: number, planIncluded = false): ModelIntelLite {
  const [provider, name] = modelKey.split("/");
  return {
    provider,
    model: name,
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
    plan: {
      type: planIncluded ? "subscription" : "pay_as_you_go",
      quotaPressure: planIncluded ? "low" : "unknown",
      effectiveCostBand: planIncluded ? "free_or_sunk" : "unknown",
      sources: ["test"],
    },
    scenarioAbility: scenarioAbility(),
    freshness: FRESH_TEST_TIMESTAMP,
    sources: ["test"],
  };
}

function snapshot(models: ModelIntelLite[]): ModelIntelSnapshot {
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "snap-e2e",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models,
  };
}

function request(): RouterLiteRequest {
  return {
    sessionKey: "slack:e2e",
    turnId: "turn-e2e",
    liveRoute: "delegate",
    liveModel: "openai/gpt-5.5",
    judge: { route: "delegate", confidence: 0.9, complexity: "normal" },
    runtime: { channel: "slack" },
    snapshotId: "snap-e2e",
  };
}

describe("Auto Router v3 E2E smoke", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-router-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("RT-E-001 wires wizard config, cost ledger, budget gating, and promotion state", () => {
    const wizard = createWizardConfig(["openai/gpt-5.5", "openai/gpt-5-mini"], {
      now: "2026-05-14T00:00:00.000Z",
      budgetInput: "100",
      modelPlanTypes: {
        "openai/gpt-5.5": "subscription",
        "openai/gpt-5-mini": "pay_as_you_go",
      },
    });
    expect(wizard.budget).toEqual({ monthly: 100, currency: "USD" });

    const opened = openSqliteCostEventStore({ openclawHome: tempDir });
    expect(opened.status).toBe("ok");
    opened.store?.record({
      ts: "2026-05-14T00:00:00.000Z",
      model: "openai/gpt-5.5",
      complexity: "normal",
      route: "delegate",
      costUsd: 102,
    });
    const report = generateCostReport(opened.store?.list() ?? [], {
      period: "month",
      now: Date.parse("2026-05-14T01:00:00.000Z"),
    });
    opened.store?.close();
    const budget = evaluateBudget(wizard.budget!.monthly, report.totalUsd);
    expect(budget).toMatchObject({
      action: "plan_only",
      reasonCodes: ["budget_exceeded_plan_only"],
    });

    const promotionState = buildPromotionState([
      { ts: "2026-05-14T00:30:00.000Z", model: "openai/gpt-5-mini", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" },
    ], Object.keys(wizard.models));
    const recommendation = selectShadowRecommendation(
      request(),
      snapshot([
        model("openai/gpt-5.5", 20, true),
        model("openai/gpt-5-mini", 2),
      ]),
      "balanced",
      { budget, promotionState },
    );

    expect(recommendation).toMatchObject({
      recommendedModel: "openai/gpt-5.5",
      mode: "shadow",
      ignoredReason: undefined,
    });
    expect(recommendation.reasonCodes).toEqual(expect.arrayContaining(["budget_exceeded_plan_only", "promotion_shadow"]));
    expect(recommendation.rejectedModels).toContainEqual({ model: "openai/gpt-5-mini", reason: "budget_exceeded_plan_only" });
  });
});
