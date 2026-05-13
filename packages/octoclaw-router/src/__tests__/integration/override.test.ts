import { describe, expect, it } from "vitest";

import type { ModelIntelLite, RouterLiteRequest } from "../../decision/contracts.js";
import {
  banModel,
  createEmptyOverrides,
  markDispreferred,
  renderOverrideList,
  resetModelOverrides,
  setScoreOverride,
  toScoringOverrides,
} from "../../overrides/index.js";
import { buildRecommendation, scoreModel, type ScoringContext } from "../../scoring/index.js";

function model(modelKey: string, tier: ModelIntelLite["capability"]["codingTier"], price = 10): ModelIntelLite {
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
      codingTier: tier,
      confidence: "high",
      evidence: ["declared"],
      sources: ["test"],
    },
    health: { available: "yes", cooldown: false, quotaPressure: "low", recentFailureRate: 0.01, p95LatencyMs: 800, sources: ["test"] },
    plan: { type: "pay_as_you_go", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: ["test"] },
    sources: ["test"],
  };
}

function context(complexity: RouterLiteRequest["judge"]["complexity"], allModels: ModelIntelLite[], overrides = createEmptyOverrides()): ScoringContext {
  return {
    complexity,
    allModels,
    runtimeSignals: {},
    ...toScoringOverrides(overrides),
  };
}

describe("user override RT-O-001..005", () => {
  it("RT-O-001 score override takes effect immediately and is persisted in config", () => {
    const overrides = setScoreOverride(createEmptyOverrides(), "openai/gpt-5.5", "complex", 75, "2026-05-13T00:00:00.000Z");
    const subject = model("openai/gpt-5.5", "strong");

    expect(scoreModel(subject, context("complex", [subject], overrides))).toBe(75);
    expect(overrides.scoreOverrides["openai/gpt-5.5"]?.complex).toBe(75);
  });

  it("RT-O-002 dispreferred is soft and only loses close tie-breakers", () => {
    const overrides = markDispreferred(createEmptyOverrides(), "openai/gpt-5.5", "normal", "2026-05-13T00:00:00.000Z");
    const models = [
      model("openai/gpt-5.5", "standard", 1),
      model("zhipu/glm-5.1", "standard", 100),
    ];

    expect(buildRecommendation(models, context("normal", models, overrides)).recommendedModel).toBe("openai/gpt-5.5");
  });

  it("RT-O-003 ban is hard and excludes a model completely", () => {
    const overrides = banModel(createEmptyOverrides(), "openai/gpt-5.5", "normal", "2026-05-13T00:00:00.000Z");
    const models = [model("openai/gpt-5.5", "frontier"), model("zhipu/glm-5.1", "standard")];
    const recommendation = buildRecommendation(models, context("normal", models, overrides));

    expect(recommendation.recommendedModel).toBe("zhipu/glm-5.1");
    expect(recommendation.reasonCodes).toContain("user_ban_active");
  });

  it("RT-O-004 score reset removes override", () => {
    const withOverride = setScoreOverride(createEmptyOverrides(), "openai/gpt-5.5", "complex", 75, "2026-05-13T00:00:00.000Z");
    const reset = resetModelOverrides(withOverride, "openai/gpt-5.5");

    expect(reset.scoreOverrides["openai/gpt-5.5"]).toBeUndefined();
    expect(reset.entries).toEqual([]);
  });

  it("RT-O-005 override list is visible for CLI rendering", () => {
    let overrides = setScoreOverride(createEmptyOverrides(), "openai/gpt-5.5", "complex", 75, "2026-05-13T00:00:00.000Z");
    overrides = markDispreferred(overrides, "zhipu/glm-5.1", "normal", "2026-05-13T00:00:00.000Z", "unstable");
    overrides = banModel(overrides, "anthropic/claude-opus-4", "deep", "2026-05-13T00:00:00.000Z");

    expect(renderOverrideList(overrides)).toContain("openai/gpt-5.5");
    expect(JSON.parse(renderOverrideList(overrides, "json")).overrides).toHaveLength(3);
  });
});
