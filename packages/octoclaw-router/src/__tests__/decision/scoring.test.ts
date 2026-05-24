import { describe, expect, it } from "vitest";

import type { ModelIntelLite, RouterLiteRequest } from "../../decision/contracts.js";
import {
  BALANCED_WEIGHTS,
  buildRecommendation,
  capabilityScoreFor,
  costScoreFor,
  qualityFloorPassesFor,
  scoreModel,
  type ScoringContext,
} from "../../scoring/index.js";
import { buildPromotionState } from "../../promotion/index.js";

function model(modelKey: string, tier: ModelIntelLite["capability"]["codingTier"], overrides: Partial<ModelIntelLite> = {}): ModelIntelLite {
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
      blendedUsdPerMTok: 10,
      confidence: "high",
      sources: ["test"],
    },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: tier,
      confidence: "high",
      evidence: ["declared"],
      sources: ["test"],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "low",
      recentFailureRate: 0.01,
      p95LatencyMs: 700,
      sources: ["test"],
    },
    plan: {
      type: "pay_as_you_go",
      quotaPressure: "unknown",
      effectiveCostBand: "unknown",
      sources: ["test"],
    },
    sources: ["test"],
    ...overrides,
  };
}

function context(complexity: RouterLiteRequest["judge"]["complexity"], allModels: ModelIntelLite[], extra: Partial<ScoringContext> = {}): ScoringContext {
  return {
    complexity,
    allModels,
    runtimeSignals: {},
    userBans: {},
    userDispreferred: {},
    scoreOverrides: {},
    ...extra,
  };
}

describe("scoring engine RT-S-001..010", () => {
  it("CSC-003 uses unified capability score before tier priors", () => {
    const subject = model("openai/gpt-5.4-mini", "mini", {
      capability: {
        ...model("openai/gpt-5.4-mini", "mini").capability,
        capabilityScore: {
          score: 86,
          confidence: "high",
          contributions: [],
          reasonCodes: ["test_score"],
        },
      },
    });

    expect(capabilityScoreFor(subject, "complex")).toBe(86);
  });

  it("keeps low-confidence mini benchmark scores below complex and deep quality floors", () => {
    const subject = model("deepseek/deepseek-v4-flash", "mini", {
      capability: {
        ...model("deepseek/deepseek-v4-flash", "mini").capability,
        capabilityScore: {
          score: 90,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });
    const frontier = model("deepseek/deepseek-v4-pro", "frontier", {
      marketPrice: { blendedUsdPerMTok: 20, confidence: "high", sources: ["test"] },
    });
    const models = [subject, frontier];

    expect(capabilityScoreFor(subject, "deep")).toBeLessThan(45);
    expect(buildRecommendation(models, context("complex", models)).recommendedModel).toBe("deepseek/deepseek-v4-pro");
    expect(buildRecommendation(models, context("deep", models)).recommendedModel).toBe("deepseek/deepseek-v4-pro");
    expect(buildRecommendation(models, context("deep", models)).rejectedModels).toContainEqual({
      model: "deepseek/deepseek-v4-flash",
      reason: "quality_floor_not_met",
    });
  });

  it("low-confidence capabilityScore does not promote mini to strong tier", () => {
    const subject = model("openai/gpt-5.4-mini", "mini", {
      capability: {
        ...model("openai/gpt-5.4-mini", "mini").capability,
        capabilityScore: {
          score: 86,
          confidence: "low",
          contributions: [],
          reasonCodes: ["test_score"],
        },
      },
    });

    expect(capabilityScoreFor(subject, "complex")).toBeLessThan(45);

    // Quality floor for complex = strong, effective tier should stay "mini" for low confidence
    expect(qualityFloorPassesFor(subject, "complex")).toBe(false);
    expect(qualityFloorPassesFor(subject, "deep")).toBe(false);
  });

  it("medium-confidence capabilityScore partially blends toward tier prior", () => {
    const subject = model("openai/gpt-5.4-mini", "mini", {
      capability: {
        ...model("openai/gpt-5.4-mini", "mini").capability,
        capabilityScore: {
          score: 86,
          confidence: "medium",
          contributions: [],
          reasonCodes: ["test_score"],
        },
      },
    });

    expect(capabilityScoreFor(subject, "complex")).toBeGreaterThan(60);
    expect(qualityFloorPassesFor(subject, "complex")).toBe(false);
  });

  it("high-confidence capabilityScore still uses raw score unchanged", () => {
    const subject = model("openai/gpt-5.4-mini", "mini", {
      capability: {
        ...model("openai/gpt-5.4-mini", "mini").capability,
        capabilityScore: {
          score: 86,
          confidence: "high",
          contributions: [],
          reasonCodes: ["test_score"],
        },
      },
    });

    expect(capabilityScoreFor(subject, "complex")).toBe(86);
    // High-confidence score CAN promote tier
    expect(qualityFloorPassesFor(subject, "complex")).toBe(true);
  });

  it("keeps low-confidence family scores ordered by model generation", () => {
    const glm51 = model("zhipu/glm-5.1", "strong", {
      capability: {
        ...model("zhipu/glm-5.1", "strong").capability,
        capabilityScore: {
          score: 77,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });
    const glm5 = model("zhipu/glm-5", "strong", {
      capability: {
        ...model("zhipu/glm-5", "strong").capability,
        capabilityScore: {
          score: 78,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });
    const glm47 = model("zhipu/glm-4.7", "strong", {
      capability: {
        ...model("zhipu/glm-4.7", "strong").capability,
        capabilityScore: {
          score: 85,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });

    expect(capabilityScoreFor(glm51, "complex")).toBeGreaterThan(capabilityScoreFor(glm5, "complex"));
    expect(capabilityScoreFor(glm5, "complex")).toBeGreaterThan(capabilityScoreFor(glm47, "complex"));
  });

  it("does not rank DeepSeek pro and Kimi current-gen below GLM 4.7 on weak evidence", () => {
    const glm47 = model("zhipu/glm-4.7", "strong", {
      capability: {
        ...model("zhipu/glm-4.7", "strong").capability,
        capabilityScore: {
          score: 85,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });
    const deepseekPro = model("deepseek/deepseek-v4-pro", "strong", {
      capability: {
        ...model("deepseek/deepseek-v4-pro", "strong").capability,
        capabilityScore: {
          score: 61,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });
    const kimi26 = model("moonshotai/kimi-k2.6", "strong", {
      capability: {
        ...model("moonshotai/kimi-k2.6", "strong").capability,
        capabilityScore: {
          score: 70,
          confidence: "low",
          contributions: [],
          reasonCodes: ["catalog_low_confidence"],
        },
      },
    });

    expect(capabilityScoreFor(deepseekPro, "complex")).toBeGreaterThanOrEqual(capabilityScoreFor(glm47, "complex"));
    expect(capabilityScoreFor(kimi26, "complex")).toBeGreaterThanOrEqual(capabilityScoreFor(glm47, "complex"));
  });

  it("low-confidence mini does not outrank true frontier for deep", () => {
    const miniLow = model("deepseek/deepseek-v4-flash", "mini", {
      marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] },
      capability: {
        ...model("deepseek/deepseek-v4-flash", "mini").capability,
        capabilityScore: {
          score: 90,
          confidence: "low",
          contributions: [],
          reasonCodes: ["test_score"],
        },
      },
    });
    const proFrontier = model("deepseek/deepseek-v4-pro", "frontier", {
      marketPrice: { blendedUsdPerMTok: 5, confidence: "high", sources: ["test"] },
    });
    const models = [miniLow, proFrontier];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).toBe("deepseek/deepseek-v4-pro");
    expect(recommendation.rejectedModels).toContainEqual({ model: "deepseek/deepseek-v4-flash", reason: "quality_floor_not_met" });
  });

  it("RT-S-001 recommends frontier model for deep complexity", () => {
    const models = [
      model("openai/gpt-5.5", "frontier"),
      model("zhipu/glm-5.1", "standard"),
      model("openai/gpt-5-mini", "mini"),
    ];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).toBe("openai/gpt-5.5");
    expect(recommendation.reasonCodes).toContain("quality_floor_pass:frontier");
    expect(recommendation.ignoredReason).toBeUndefined();
  });

  it("RT-S-002 recommends cheapest floor-passing mini model for simple complexity", () => {
    const models = [
      model("openai/gpt-5.5", "frontier", { marketPrice: { blendedUsdPerMTok: 30, confidence: "high", sources: ["test"] } }),
      model("zhipu/glm-5.1", "standard", { marketPrice: { blendedUsdPerMTok: 10, confidence: "high", sources: ["test"] } }),
      model("openai/gpt-5-mini", "mini", { marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] } }),
    ];

    const recommendation = buildRecommendation(models, context("simple", models));

    expect(recommendation.recommendedModel).toBe("openai/gpt-5-mini");
    expect(recommendation.reasonCodes).toContain("quality_floor_pass:mini");
  });

  it("RT-S-003 never recommends unconfigured models", () => {
    const models = [
      model("anthropic/claude-opus-4", "frontier", { configured: false }),
      model("openai/gpt-5.5", "frontier"),
    ];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).not.toBe("anthropic/claude-opus-4");
    expect(recommendation.rejectedModels).toContainEqual({ model: "anthropic/claude-opus-4", reason: "not_configured" });
  });

  it("RT-S-004 excludes cooldown models", () => {
    const models = [
      model("openai/gpt-5.5", "frontier", { health: { ...model("x/y", "frontier").health, cooldown: true } }),
      model("anthropic/claude-sonnet", "frontier"),
    ];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).toBe("anthropic/claude-sonnet");
    expect(recommendation.rejectedModels).toContainEqual({ model: "openai/gpt-5.5", reason: "cooldown_active" });
  });

  it("RT-S-005 does not treat unknown quota pressure as free", () => {
    const models = [
      model("openai/gpt-5.5", "strong", {
        plan: { type: "subscription", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: ["test"] },
      }),
      model("zhipu/glm-5.1", "strong", {
        plan: { type: "subscription", quotaPressure: "low", effectiveCostBand: "free_or_sunk", sources: ["test"] },
      }),
    ];
    const scoringContext = context("complex", models);

    expect(costScoreFor(models[1]!, scoringContext)).toBe(100);
    expect(costScoreFor(models[0]!, scoringContext)).not.toBe(100);
    expect(buildRecommendation(models, scoringContext).recommendedModel).toBe("zhipu/glm-5.1");
  });

  it("RT-S-006 filters models without tool support when tools are required", () => {
    const models = [
      model("provider/a", "strong", { capability: { ...model("x/y", "strong").capability, toolUse: "no" } }),
      model("provider/b", "strong"),
    ];

    const recommendation = buildRecommendation(models, context("complex", models, { runtimeSignals: { needsTools: true } }));

    expect(recommendation.recommendedModel).toBe("provider/b");
    expect(recommendation.rejectedModels).toContainEqual({ model: "provider/a", reason: "tool_support_insufficient" });
  });

  it("RT-S-007 uses balanced weights 35/20/20/15/10", () => {
    const subject = model("provider/a", "strong", {
      marketPrice: { blendedUsdPerMTok: 5, confidence: "high", sources: ["test"] },
      health: { ...model("x/y", "strong").health, recentFailureRate: 0.05, p95LatencyMs: 1500 },
    });
    const allModels = [subject, model("provider/b", "strong", { marketPrice: { blendedUsdPerMTok: 10, confidence: "high", sources: ["test"] } })];

    const result = scoreModel(subject, context("complex", allModels));

    expect(BALANCED_WEIGHTS).toEqual({ capability: 0.35, qualityFloor: 0.20, cost: 0.20, stability: 0.15, speed: 0.10 });
    expect(result).toBeCloseTo(80 * 0.35 + 100 * 0.20 + 80 * 0.20 + 90 * 0.15 + 80 * 0.10, 5);
  });

  it("RT-S-008 user ban beats scoring", () => {
    const models = [model("openai/gpt-5.5", "frontier"), model("zhipu/glm-5.1", "standard")];
    const recommendation = buildRecommendation(models, context("normal", models, {
      userBans: { "openai/gpt-5.5": ["normal"] },
    }));

    expect(recommendation.recommendedModel).toBe("zhipu/glm-5.1");
    expect(recommendation.reasonCodes).toContain("user_ban_active");
  });

  it("RT-S-009 dispreferred model loses tie-breakers", () => {
    const models = [model("provider/a", "standard"), model("provider/b", "standard")];
    const recommendation = buildRecommendation(models, context("normal", models, {
      userDispreferred: { "provider/a": ["normal"] },
    }));

    expect(recommendation.recommendedModel).toBe("provider/b");
    expect(recommendation.reasonCodes).toContain("user_dispreferred_tiebreak");
  });

  it("uses OpenClaw default and fallback order for near-tied models", () => {
    const models = [
      model("provider/cheap", "standard", { marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] } }),
      model("provider/default", "standard", { tags: ["default"], marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] } }),
      model("provider/fallback1", "standard", { marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] } }),
    ];

    expect(buildRecommendation(models, context("normal", models, {
      nativeFallbackOrder: ["provider/fallback1"],
    })).recommendedModel).toBe("provider/default");
  });

  it("emits cooldown reason codes for excluded fallback models", () => {
    const models = [
      model("provider/default", "standard", {
        tags: ["default"],
        health: { ...model("x/y", "standard").health, cooldown: true, cooldownReason: "rate_limit_429" },
      }),
      model("provider/fallback1", "standard", { tags: ["fallback#1"] }),
    ];

    const recommendation = buildRecommendation(models, context("normal", models, {
      nativeFallbackOrder: ["provider/fallback1"],
    }));

    expect(recommendation.recommendedModel).toBe("provider/fallback1");
    expect(recommendation.reasonCodes).toContain("cooldown:rate_limit_429:provider/default");
  });

  it("RT-S-010 emits clear ignored reasons", () => {
    expect(buildRecommendation([model("a/b", "frontier", { configured: false })], context("deep", [model("a/b", "frontier", { configured: false })])).ignoredReason).toBe("all_unconfigured");
    expect(buildRecommendation([model("a/b", "frontier", { health: { ...model("x/y", "frontier").health, cooldown: true } })], context("deep", [model("a/b", "frontier")])).ignoredReason).toBe("all_cooldown");
    expect(buildRecommendation([model("a/b", "mini")], context("deep", [model("a/b", "mini")])).ignoredReason).toBe("no_quality_floor_match");
    expect(buildRecommendation([], context("normal", [])).ignoredReason).toBe("no_capability_data");
    expect(buildRecommendation([model("a/b", "standard")], context("normal", [model("a/b", "standard")], { userBans: { "a/b": ["normal"] } })).ignoredReason).toBe("all_banned");
  });

  it("RT-P-010 marks promoted configured scoring recommendations live", () => {
    const models = [
      model("openai/gpt-5.5", "standard", { marketPrice: { blendedUsdPerMTok: 20, confidence: "high", sources: ["test"] } }),
      model("deepseek/deepseek-v4", "standard", { marketPrice: { blendedUsdPerMTok: 2, confidence: "high", sources: ["test"] } }),
    ];
    const promotionState = buildPromotionState([
      { ts: "2026-05-13T00:00:00.000Z", model: "deepseek/deepseek-v4", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" },
    ], models.map((entry) => entry.modelKey));

    const recommendation = buildRecommendation(models, context("normal", models, { promotionState }));

    expect(recommendation.recommendedModel).toBe("deepseek/deepseek-v4");
    expect(recommendation.mode).toBe("live");
    expect(recommendation.reasonCodes).toContain("promotion_live");
  });

  it("RT-$-006 applies budget plan-only gating in scoring recommendations", () => {
    const models = [
      model("openai/gpt-5.5", "standard", {
        marketPrice: { blendedUsdPerMTok: 20, confidence: "high", sources: ["test"] },
        plan: { type: "subscription", quotaPressure: "low", effectiveCostBand: "free_or_sunk", sources: ["test"] },
      }),
      model("deepseek/deepseek-v4", "standard", { marketPrice: { blendedUsdPerMTok: 2, confidence: "high", sources: ["test"] } }),
    ];

    const recommendation = buildRecommendation(models, context("normal", models, {
      budget: { usedPercent: 102, action: "plan_only", reasonCodes: ["budget_exceeded_plan_only"] },
    }));

    expect(recommendation.recommendedModel).toBe("openai/gpt-5.5");
    expect(recommendation.rejectedModels).toContainEqual({ model: "deepseek/deepseek-v4", reason: "budget_exceeded_plan_only" });
    expect(recommendation.reasonCodes).toContain("budget_exceeded_plan_only");
  });

  it("CEC-008 safety filters reject unconfigured, unavailable, and cooldown models even with high capabilityScore", () => {
    const highScoreCap = {
      ...model("x/y", "frontier").capability,
      capabilityScore: { score: 95, confidence: "high" as const, contributions: [], reasonCodes: ["test_score"] },
    };

    const unconfigured = model("test/unconfigured-high", "frontier", {
      configured: false,
      capability: highScoreCap,
    });
    const unavailable = model("test/unavailable-high", "frontier", {
      health: { ...model("x/y", "frontier").health, available: "no" },
      capability: highScoreCap,
    });
    const cooldown = model("test/cooldown-high", "frontier", {
      health: { ...model("x/y", "frontier").health, cooldown: true },
      capability: highScoreCap,
    });
    const eligible = model("test/eligible-normal", "strong");

    const models = [unconfigured, unavailable, cooldown, eligible];

    const recommendation = buildRecommendation(models, context("complex", models));

    expect(recommendation.recommendedModel).toBe("test/eligible-normal");
    expect(recommendation.rejectedModels).toContainEqual({ model: "test/unconfigured-high", reason: "not_configured" });
    expect(recommendation.rejectedModels).toContainEqual({ model: "test/unavailable-high", reason: "unavailable" });
    expect(recommendation.rejectedModels).toContainEqual({ model: "test/cooldown-high", reason: "cooldown_active" });
  });

  it("CEC-009 buildRecommendation does not expose internal capability scores or prices", () => {
    const models = [
      model("openai/gpt-5.5", "frontier", {
        capability: {
          ...model("openai/gpt-5.5", "frontier").capability,
          capabilityScore: { score: 95, confidence: "high", contributions: [], reasonCodes: ["test_score"] },
        },
        marketPrice: { blendedUsdPerMTok: 11.25, confidence: "high", sources: ["test"] },
      }),
    ];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).toBe("openai/gpt-5.5");
    const recKeys = Object.keys(recommendation);
    expect(recKeys).not.toContain("capabilityScore");
    expect(recKeys).not.toContain("internalScore");
    expect(recKeys).not.toContain("estimatedPrice");
    expect(recKeys).not.toContain("price");

    for (const rejected of recommendation.rejectedModels) {
      const rejKeys = Object.keys(rejected);
      expect(rejKeys).not.toContain("score");
      expect(rejKeys).not.toContain("price");
    }
  });
});
