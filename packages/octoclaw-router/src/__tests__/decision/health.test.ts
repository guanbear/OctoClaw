import { describe, expect, it } from "vitest";

import type { ModelIntelLite, RouterLiteRequest } from "../../decision/contracts.js";
import { ModelHealthTracker } from "../../health/index.js";
import { buildRecommendation, speedScoreFor, type ScoringContext } from "../../scoring/index.js";

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
      p95LatencyMs: 800,
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

describe("health and stability RT-H-001..005", () => {
  it("RT-H-001 triggers 30 minute cooldown when failure rate reaches 20 percent", () => {
    let now = new Date("2026-05-13T00:00:00.000Z").getTime();
    const tracker = new ModelHealthTracker(() => now);

    for (let index = 0; index < 7; index += 1) tracker.recordCall("openai/gpt-5.5", { success: true, latencyMs: 800 });
    for (let index = 0; index < 3; index += 1) tracker.recordCall("openai/gpt-5.5", { success: false, errorCode: "500", latencyMs: 1200 });

    const snapshot = tracker.snapshot("openai/gpt-5.5");
    expect(snapshot.recentFailureRate).toBeGreaterThanOrEqual(0.20);
    expect(snapshot.cooldown).toBe(true);
    expect(snapshot.cooldownUntil).toBe(now + 30 * 60 * 1000);
  });

  it("RT-H-002 triggers immediate 10 minute cooldown on rate limit", () => {
    const now = new Date("2026-05-13T00:00:00.000Z").getTime();
    const tracker = new ModelHealthTracker(() => now);

    tracker.recordCall("openai/gpt-5.5", { success: false, errorCode: "429", latencyMs: 300 });

    const snapshot = tracker.snapshot("openai/gpt-5.5");
    expect(snapshot.cooldown).toBe(true);
    expect(snapshot.cooldownUntil).toBe(now + 10 * 60 * 1000);
  });

  it("RT-H-003 expires cooldown and allows a model to be tried again", () => {
    let now = new Date("2026-05-13T00:00:00.000Z").getTime();
    const tracker = new ModelHealthTracker(() => now);

    tracker.recordCall("openai/gpt-5.5", { success: false, errorCode: "429" });
    now += 31 * 60 * 1000;

    expect(tracker.snapshot("openai/gpt-5.5").cooldown).toBe(false);

    for (let index = 0; index < 10; index += 1) {
      tracker.recordCall("openai/gpt-5.5", { success: index >= 7, errorCode: index < 7 ? "500" : undefined });
    }
    expect(tracker.snapshot("openai/gpt-5.5").cooldown).toBe(true);
  });

  it("RT-H-004 downweights slow models without excluding them", () => {
    const fast = model("openai/gpt-5.5", "strong", { health: { ...model("x/y", "strong").health, p95LatencyMs: 800 } });
    const slow = model("zhipu/glm-5.1", "strong", { health: { ...model("x/y", "strong").health, p95LatencyMs: 1500 } });

    expect(speedScoreFor(fast)).toBe(100);
    expect(speedScoreFor(slow)).toBe(80);
    expect(buildRecommendation([slow], context("complex", [slow])).eligibleModels).toEqual(["zhipu/glm-5.1"]);
  });

  it("RT-H-005 switches to an equal-tier healthy provider when the first provider is in cooldown", () => {
    const models = [
      model("openai/gpt-5.5", "frontier", { health: { ...model("x/y", "frontier").health, cooldown: true } }),
      model("anthropic/claude-sonnet", "frontier"),
    ];

    const recommendation = buildRecommendation(models, context("deep", models));

    expect(recommendation.recommendedModel).toBe("anthropic/claude-sonnet");
    expect(recommendation.reasonCodes).toContain("switched_provider_for_stability");
  });
});
