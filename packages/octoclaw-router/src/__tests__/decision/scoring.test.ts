import { describe, expect, it } from "vitest";

import type { ModelIntelLite, RouterLiteRequest } from "../../decision/contracts.js";
import {
  BALANCED_WEIGHTS,
  buildRecommendation,
  costScoreFor,
  scoreModel,
  type ScoringContext,
} from "../../scoring/index.js";

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

  it("RT-S-010 emits clear ignored reasons", () => {
    expect(buildRecommendation([model("a/b", "frontier", { configured: false })], context("deep", [model("a/b", "frontier", { configured: false })])).ignoredReason).toBe("all_unconfigured");
    expect(buildRecommendation([model("a/b", "frontier", { health: { ...model("x/y", "frontier").health, cooldown: true } })], context("deep", [model("a/b", "frontier")])).ignoredReason).toBe("all_cooldown");
    expect(buildRecommendation([model("a/b", "mini")], context("deep", [model("a/b", "mini")])).ignoredReason).toBe("no_quality_floor_match");
    expect(buildRecommendation([], context("normal", [])).ignoredReason).toBe("no_capability_data");
    expect(buildRecommendation([model("a/b", "standard")], context("normal", [model("a/b", "standard")], { userBans: { "a/b": ["normal"] } })).ignoredReason).toBe("all_banned");
  });
});
