import { describe, expect, it } from "vitest";
import { selectShadowRecommendation } from "../shadow-selector.js";
import type { ModelIntelLite, ModelIntelSnapshot, RouterLiteRequest, ScenarioAbilityLite } from "../contracts.js";

function makeRequest(overrides?: Partial<RouterLiteRequest>): RouterLiteRequest {
  return {
    sessionKey: "test-session",
    turnId: "turn-001",
    liveRoute: "delegate",
    judge: { route: "delegate", confidence: 0.9, complexity: "normal" },
    runtime: {},
    snapshotId: "snap-001",
    ...overrides,
  };
}

function makeModel(overrides?: Partial<ModelIntelLite>): ModelIntelLite {
  const scenarioAbility: ScenarioAbilityLite = {
    codingWorker: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
    agenticToolTask: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
    researchLookup: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
    dataLogAnalysis: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
    mainReasoning: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
    defaultDelegate: { tier: "B", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
  };
  return {
    provider: "cliproxyapi",
    model: "gpt-5.5-mini",
    modelKey: "cliproxyapi/gpt-5.5-mini",
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: ["configured"],
    marketPrice: { confidence: "high", sources: ["openclaw_config"], blendedUsdPerMTok: 1 },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: "standard",
      confidence: "high",
      evidence: ["declared"],
      sources: ["openclaw_config"],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "low",
      p50FirstTokenMs: 100,
      recentFailureRate: 0,
      sources: ["openclaw_models_list"],
    },
    plan: {
      type: "pay_as_you_go",
      quotaPressure: "low",
      effectiveCostBand: "cheap",
      sources: ["openclaw_config"],
    },
    sources: ["openclaw_config"],
    scenarioAbility,
    ...overrides,
  };
}

function makeSnapshot(models: ModelIntelLite[]): ModelIntelSnapshot {
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "snap-001",
    generatedAt: "2026-05-10T00:00:00.000Z",
    sourceStatus: [],
    models,
  };
}

describe("router-lite shadow selector", () => {
  it("ignores empty snapshots with no eligible model", () => {
    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([]));

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.ignoredReason).toBe("no_eligible_model");
    expect(recommendation.mode).toBe("shadow");
  });

  it("rejects unconfigured models", () => {
    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([makeModel({ configured: false })]));

    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "not_configured" });
  });

  it("uses not_configured as ignored reason when every candidate is proposal-only", () => {
    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([makeModel({ configured: false })]));

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.ignoredReason).toBe("not_configured");
    expect(recommendation.reasonCodes).toContain("hard_gate_rejected");
    expect(recommendation.reasonCodes).toContain("ignored_not_configured");
  });

  it("rejects unavailable models", () => {
    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([makeModel({ available: "no" })]));

    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "not_available" });
  });

  it("rejects cooldown models", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest(),
      makeSnapshot([makeModel({ health: { ...makeModel().health, cooldown: true } })]),
    );

    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "cooldown_active" });
  });

  it("rejects models under high quota pressure", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest(),
      makeSnapshot([makeModel({ health: { ...makeModel().health, quotaPressure: "high" } })]),
    );

    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "quota_pressure_high" });
  });

  it("rejects models without required tool support", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { needsTools: true } }),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, toolUse: "no" } })]),
    );

    expect(recommendation.rejectedModels).toContainEqual({
      model: "cliproxyapi/gpt-5.5-mini",
      reason: "tool_support_insufficient",
    });
  });

  it("rejects models without structured output support when required", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { needsStructuredOutput: true } }),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, structuredOutput: "no" } })]),
    );

    expect(recommendation.rejectedModels).toContainEqual({
      model: "cliproxyapi/gpt-5.5-mini",
      reason: "structured_output_insufficient",
    });
  });

  it("accepts models with structured output when required", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { needsStructuredOutput: true } }),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, structuredOutput: "yes" } })]),
    );

    expect(recommendation.eligibleModels).toContain("cliproxyapi/gpt-5.5-mini");
    expect(recommendation.rejectedModels).not.toContainEqual({
      model: "cliproxyapi/gpt-5.5-mini",
      reason: "structured_output_insufficient",
    });
  });

  it("rejects models below requested context window", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { minContextTokens: 200000 } }),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, contextWindow: 128000 } })]),
    );

    expect(recommendation.rejectedModels).toContainEqual({
      model: "cliproxyapi/gpt-5.5-mini",
      reason: "context_window_too_small",
    });
  });

  it("rejects models below the quality floor", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ judge: { route: "delegate", confidence: 0.9, complexity: "complex" } }),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, codingTier: "mini" } })]),
    );

    expect(recommendation.qualityFloor).toBe("strong");
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "quality_floor_not_met" });
  });

  it("chooses the cheaper model in cost_first mode", () => {
    const cheap = makeModel({ model: "cheap", modelKey: "test/cheap", marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 1 } });
    const expensive = makeModel({ model: "expensive", modelKey: "test/expensive", marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 5 } });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([expensive, cheap]), "cost_first");

    expect(recommendation.recommendedModel).toBe("test/cheap");
    expect(recommendation.scoringMode).toBe("cost_first");
  });

  it("chooses the better quality-cost balance in balanced mode", () => {
    const cheapMini = makeModel({
      model: "cheap-standard",
      modelKey: "test/cheap-standard",
      marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 1 },
      capability: { ...makeModel().capability, codingTier: "standard" },
    });
    const strong = makeModel({
      model: "strong",
      modelKey: "test/strong",
      marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 1 },
      capability: { ...makeModel().capability, codingTier: "strong" },
      scenarioAbility: { ...makeModel().scenarioAbility!, defaultDelegate: { tier: "A", confidence: "high", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] } },
    });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([cheapMini, strong]), "balanced");

    expect(recommendation.recommendedModel).toBe("test/strong");
  });

  it("rejects stale evidence instead of turning it into positive recommendation evidence", () => {
    const fresh = makeModel({
      model: "fresh",
      modelKey: "test/fresh",
      freshness: new Date().toISOString(),
    });
    const stale = makeModel({
      model: "stale",
      modelKey: "test/stale",
      freshness: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      capability: { ...makeModel().capability, evidence: ["heuristic"] },
    });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([stale, fresh]), "balanced");

    expect(recommendation.eligibleModels).toEqual(["test/fresh"]);
    expect(recommendation.rejectedModels).toContainEqual({ model: "test/stale", reason: "stale_evidence" });
  });

  it("chooses the more stable model in reliable_fast mode", () => {
    const stable = makeModel({
      model: "stable",
      modelKey: "test/stable",
      health: { ...makeModel().health, recentFailureRate: 0.01, p50FirstTokenMs: 100 },
    });
    const flaky = makeModel({
      model: "flaky",
      modelKey: "test/flaky",
      health: { ...makeModel().health, recentFailureRate: 0.8, p50FirstTokenMs: 100 },
    });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([flaky, stable]), "reliable_fast");

    expect(recommendation.recommendedModel).toBe("test/stable");
  });

  it("ignores status or provenance requests", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { statusOrProvenanceRequest: true } }),
      makeSnapshot([makeModel()]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.ignoredReason).toBe("status_or_provenance_request");
  });

  it("sets ignoredReason to explicit_override when operator chose a model", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { explicitOverride: "cliproxyapi/gpt-5.5" } }),
      makeSnapshot([makeModel()]),
    );

    expect(recommendation.recommendedModel).toBeDefined();
    expect(recommendation.ignoredReason).toBe("explicit_override");
  });

  it("fixes status_or_provenance_request without type hack", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { statusOrProvenanceRequest: true } }),
      makeSnapshot([makeModel()]),
    );

    expect(recommendation.ignoredReason).toBe("status_or_provenance_request");
  });

  it("does not apply a free_or_sunk bonus when quota pressure is unknown", () => {
    const unknownQuotaFree = makeModel({
      model: "unknown-free",
      modelKey: "test/unknown-free",
      marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 1 },
      plan: { ...makeModel().plan, quotaPressure: "unknown", effectiveCostBand: "free_or_sunk" },
    });
    const lowQuotaFree = makeModel({
      model: "low-free",
      modelKey: "test/low-free",
      marketPrice: { confidence: "high", sources: ["test"], blendedUsdPerMTok: 1 },
      plan: { ...makeModel().plan, quotaPressure: "low", effectiveCostBand: "free_or_sunk" },
    });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([unknownQuotaFree, lowQuotaFree]), "cost_first");

    expect(recommendation.recommendedModel).toBe("test/low-free");
  });

  it("selects the only model that passes hard gates", () => {
    const rejected = makeModel({ model: "rejected", modelKey: "test/rejected", configured: false });
    const eligible = makeModel({ model: "eligible", modelKey: "test/eligible" });

    const recommendation = selectShadowRecommendation(makeRequest(), makeSnapshot([rejected, eligible]));

    expect(recommendation.recommendedModel).toBe("test/eligible");
    expect(recommendation.eligibleModels).toEqual(["test/eligible"]);
  });

  it("rejects price conflicts before scoring", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest(),
      makeSnapshot([makeModel({ marketPrice: { confidence: "low", sources: ["openclaw_config", "openrouter"], blendedUsdPerMTok: 1, conflict: true } })]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "price_conflict" });
  });

  it("rejects missing cost source evidence before scoring", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest(),
      makeSnapshot([makeModel({ marketPrice: { confidence: "unknown", sources: [], blendedUsdPerMTok: 1 } })]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "cost_evidence_missing" });
  });

  it("rejects missing capability source evidence before scoring", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest(),
      makeSnapshot([makeModel({ capability: { ...makeModel().capability, confidence: "unknown", evidence: [], sources: [] } })]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "capability_evidence_missing" });
  });

  it("uses explicit scenario ability as a hard gate", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { scenario: "codingWorker" } }),
      makeSnapshot([
        makeModel({
          scenarioAbility: {
            ...makeModel().scenarioAbility!,
            codingWorker: { tier: "C", confidence: "high", sources: [{ source: "local_replay", fetchedAt: "2026-05-10T00:00:00.000Z" }] },
          },
        }),
      ]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "scenario_ability_below_floor" });
  });

  it("does not treat inferred scenario tier without sources as hard positive evidence", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ runtime: { scenario: "codingWorker" } }),
      makeSnapshot([
        makeModel({
          scenarioAbility: {
            ...makeModel().scenarioAbility!,
            codingWorker: { tier: "B", confidence: "low", sources: [] },
          },
        }),
      ]),
    );

    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.5-mini", reason: "scenario_evidence_insufficient" });
  });

  it("does not recommend a different model when judge confidence is low", () => {
    const recommendation = selectShadowRecommendation(
      makeRequest({ judge: { route: "delegate", confidence: 0.4, complexity: "normal" } }),
      makeSnapshot([makeModel()]),
    );

    expect(recommendation.ignoredReason).toBe("low_confidence");
    expect(recommendation.recommendedModel).toBeUndefined();
  });
});
