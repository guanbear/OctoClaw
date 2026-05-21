import { describe, expect, it } from "vitest";

import type { ModelIntelLite, ModelIntelSnapshot, RouterLiteRequest, ScenarioAbilityLite } from "../../decision/contracts.js";
import { selectShadowRecommendation } from "../../decision/shadow-selector.js";

const FRESH_TEST_TIMESTAMP = new Date().toISOString();

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

function model(modelKey: string, price: number, overrides: Partial<ModelIntelLite> = {}): ModelIntelLite {
  const [provider, name] = modelKey.split("/");
  return {
    provider,
    model: name,
    modelKey,
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: [],
    marketPrice: {
      blendedUsdPerMTok: price,
      confidence: "high",
      sources: ["test"],
    },
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
      type: "pay_as_you_go",
      quotaPressure: "unknown",
      effectiveCostBand: "unknown",
      sources: ["test"],
    },
    scenarioAbility: scenarioAbility(),
    freshness: FRESH_TEST_TIMESTAMP,
    sources: ["test"],
    ...overrides,
  };
}

function snapshot(models: ModelIntelLite[]): ModelIntelSnapshot {
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "snap-promotion-test",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models,
  };
}

function request(overrides: Partial<RouterLiteRequest> = {}): RouterLiteRequest {
  return {
    sessionKey: "s1",
    turnId: "t1",
    liveRoute: "delegate",
    liveModel: "openai/gpt-5.5",
    judge: {
      route: "delegate",
      confidence: 0.9,
      complexity: "normal",
    },
    runtime: {},
    snapshotId: "snap-promotion-test",
    ...overrides,
  };
}

describe("selectShadowRecommendation promotion state", () => {
  it("RT-P-010 marks promoted configured recommendations live", () => {
    const recommendation = selectShadowRecommendation(
      request(),
      snapshot([
        model("openai/gpt-5.5", 20),
        model("deepseek/deepseek-v4", 2),
      ]),
      "balanced",
      {
        promotionDecisions: [
          { ts: "2026-05-13T00:00:00.000Z", model: "deepseek/deepseek-v4", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" },
        ],
      },
    );

    expect(recommendation.recommendedModel).toBe("deepseek/deepseek-v4");
    expect(recommendation.mode).toBe("live");
    expect(recommendation.reasonCodes).toContain("promotion_live");
  });

  it("keeps promoted recommendations in shadow when the request is ignored", () => {
    const recommendation = selectShadowRecommendation(
      request({ judge: { route: "delegate", confidence: 0.2, complexity: "normal" } }),
      snapshot([
        model("openai/gpt-5.5", 20),
        model("deepseek/deepseek-v4", 2),
      ]),
      "balanced",
      {
        promotionDecisions: [
          { ts: "2026-05-13T00:00:00.000Z", model: "deepseek/deepseek-v4", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" },
        ],
      },
    );

    expect(recommendation.ignoredReason).toBe("low_confidence");
    expect(recommendation.mode).toBe("shadow");
    expect(recommendation.reasonCodes).toContain("promotion_shadow");
  });

  it("RT-$-006 considers only plan-included models when budget is exceeded", () => {
    const recommendation = selectShadowRecommendation(
      request(),
      snapshot([
        model("openai/gpt-5.5", 20, {
          plan: { type: "subscription", quotaPressure: "low", effectiveCostBand: "free_or_sunk", sources: ["test"] },
        }),
        model("deepseek/deepseek-v4", 2),
      ]),
      "balanced",
      {
        budget: {
          usedPercent: 102,
          action: "plan_only",
          reasonCodes: ["budget_exceeded_plan_only"],
        },
      },
    );

    expect(recommendation.recommendedModel).toBe("openai/gpt-5.5");
    expect(recommendation.rejectedModels).toContainEqual({ model: "deepseek/deepseek-v4", reason: "budget_exceeded_plan_only" });
    expect(recommendation.reasonCodes).toContain("budget_exceeded_plan_only");
  });

  it("RT-$-006 reports budget_exceeded_no_plan when no plan-included model exists", () => {
    const recommendation = selectShadowRecommendation(
      request(),
      snapshot([
        model("openai/gpt-5.5", 20),
        model("deepseek/deepseek-v4", 2),
      ]),
      "balanced",
      {
        budget: {
          usedPercent: 102,
          action: "plan_only",
          reasonCodes: ["budget_exceeded_plan_only"],
        },
      },
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.ignoredReason).toBe("budget_exceeded_no_plan");
    expect(recommendation.reasonCodes).toContain("budget_exceeded_plan_only");
  });

  it("uses OpenClaw fallback order as the tie-break before price", () => {
    const recommendation = selectShadowRecommendation(
      request(),
      snapshot([
        model("provider/cheap", 1),
        model("provider/fallback1", 1),
      ]),
      "balanced",
      { nativeFallbackOrder: ["provider/fallback1"] },
    );

    expect(recommendation.recommendedModel).toBe("provider/fallback1");
  });
});
