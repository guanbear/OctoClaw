import { describe, expect, it } from "vitest";

import {
  aggregateShadowEvents,
  createPromotionDecisionEvent,
  evaluatePromotion,
  evaluatePromotionForConfiguredModel,
  evaluateRevert,
  filterPromotionDecisions,
  buildPromotionState,
  getPromotionState,
  parsePromotionDecisionLog,
  renderPromotionDecisions,
  runLightweightPromotionReview,
  type AggregatedMetrics,
  type RouterShadowEvent,
} from "../../promotion/index.js";

const GOOD_METRICS: AggregatedMetrics = {
  samples: 35,
  successRateDelta: -0.01,
  costDelta: -0.15,
  qualityRegression: 0.03,
};

function event(index: number, overrides: Partial<RouterShadowEvent> = {}): RouterShadowEvent {
  return {
    ts: new Date(Date.UTC(2026, 4, 13, 0, index)).toISOString(),
    actualModel: "openai/gpt-5.5",
    recommendedModel: "deepseek/deepseek-v4",
    promotionState: "shadow",
    judge: { complexity: "normal" },
    outcome: { success: true, costUsd: 1, latencyMs: 1000 },
    recommendation: { expectedSuccess: true, expectedCostUsd: 0.85 },
    ...overrides,
  };
}

describe("promotion evaluator RT-P-001..008", () => {
  it("RT-P-001 keeps a new model in shadow state before promotion", () => {
    const [candidate] = aggregateShadowEvents([event(1)]);

    expect(candidate).toMatchObject({ model: "deepseek/deepseek-v4", tier: "normal", samples: 1 });
    expect(event(1).promotionState).toBe("shadow");
  });

  it("RT-P-002 promotes after 30+ samples with acceptable quality and better cost", () => {
    const decision = evaluatePromotion("deepseek/deepseek-v4", "normal", GOOD_METRICS, 0);

    expect(decision).toMatchObject({ action: "promote", reason: "meets_promotion_criteria" });
    expect(decision.evidence).toEqual(GOOD_METRICS);
  });

  it("RT-P-003 holds when samples are insufficient", () => {
    expect(evaluatePromotion("deepseek/deepseek-v4", "normal", { ...GOOD_METRICS, samples: 15 }, 0))
      .toMatchObject({ action: "hold", reason: "insufficient_samples" });
  });

  it("RT-P-004 marks failed for quality regression over 5 percent and blocks retry", () => {
    expect(evaluatePromotion("deepseek/deepseek-v4", "normal", { ...GOOD_METRICS, qualityRegression: 0.07 }, 0))
      .toMatchObject({ action: "mark_failed", reason: "quality_regression", retryBlockDays: 30 });
  });

  it("RT-P-005 rejects when cost is not lower", () => {
    expect(evaluatePromotion("deepseek/deepseek-v4", "normal", { ...GOOD_METRICS, costDelta: 0 }, 0))
      .toMatchObject({ action: "reject", reason: "no_cost_benefit" });
  });

  it("RT-P-006 enforces at most one promotion per day", () => {
    expect(evaluatePromotion("deepseek/deepseek-v4", "normal", GOOD_METRICS, 1))
      .toMatchObject({ action: "hold", reason: "daily_limit_reached" });
  });

  it("keeps auto-promotion limited to configured models with retry block protection", () => {
    expect(evaluatePromotionForConfiguredModel({
      model: "deepseek/deepseek-v4",
      tier: "normal",
      metrics: GOOD_METRICS,
      todayPromotionCount: 0,
      configuredModels: ["openai/gpt-5.5"],
    })).toMatchObject({ action: "reject", reason: "not_configured" });

    expect(evaluatePromotionForConfiguredModel({
      model: "deepseek/deepseek-v4",
      tier: "normal",
      metrics: GOOD_METRICS,
      todayPromotionCount: 0,
      configuredModels: ["deepseek/deepseek-v4"],
      failedAt: "2026-05-01T00:00:00.000Z",
      now: new Date("2026-05-13T00:00:00.000Z").getTime(),
    })).toMatchObject({ action: "hold", reason: "retry_block_active" });
  });

  it("RT-P-007 reverts promoted model when recent failure rate exceeds 20 percent", () => {
    const recent = Array.from({ length: 25 }, (_, index) => event(index, {
      promotionState: "live",
      outcome: { success: index >= 7, costUsd: 1 },
    }));

    expect(evaluateRevert("deepseek/deepseek-v4", "normal", recent, true))
      .toMatchObject({ action: "revert", reason: "failure_rate_exceeded", retryBlockDays: 30 });
  });

  it("RT-P-008 parses, filters, and renders promotion decision audit records", () => {
    const decisions = [
      createPromotionDecisionEvent({
        ts: "2026-05-01T00:00:00.000Z",
        model: "a/old",
        tier: "normal",
        decision: { action: "promote", reason: "meets_promotion_criteria", evidence: GOOD_METRICS },
      }),
      createPromotionDecisionEvent({
        ts: "2026-05-13T00:00:00.000Z",
        model: "deepseek/deepseek-v4",
        tier: "normal",
        decision: { action: "reject", reason: "no_cost_benefit" },
      }),
    ];
    const parsed = parsePromotionDecisionLog(decisions.map((decision) => JSON.stringify(decision)).join("\n"));
    const filtered = filterPromotionDecisions(parsed, "7d", new Date("2026-05-13T00:00:00.000Z").getTime());

    expect(filtered).toHaveLength(1);
    expect(renderPromotionDecisions(filtered)).toContain("deepseek/deepseek-v4");
    expect(JSON.parse(renderPromotionDecisions(filtered, "json"))).toMatchObject({ decisions: [{ model: "deepseek/deepseek-v4" }] });
  });

  it("RT-P-009 derives live state from latest configured promotion decision", () => {
    const decisions = parsePromotionDecisionLog([
      JSON.stringify({ ts: "2026-05-10T00:00:00.000Z", model: "deepseek/deepseek-v4", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" }),
      JSON.stringify({ ts: "2026-05-11T00:00:00.000Z", model: "unconfigured/frontier", tier: "deep", decision: "promote", reason: "meets_promotion_criteria" }),
      JSON.stringify({ ts: "2026-05-12T00:00:00.000Z", model: "zhipu/glm-5.1", tier: "normal", decision: "promote", reason: "meets_promotion_criteria" }),
      JSON.stringify({ ts: "2026-05-13T00:00:00.000Z", model: "zhipu/glm-5.1", tier: "normal", decision: "revert", reason: "failure_rate_exceeded" }),
      JSON.stringify({ ts: "2026-05-13T01:00:00.000Z", model: "openai/gpt-5-mini", tier: "simple", decision: "mark_failed", reason: "quality_regression" }),
    ].join("\n"));

    const state = buildPromotionState(decisions, ["deepseek/deepseek-v4", "zhipu/glm-5.1", "openai/gpt-5-mini"]);

    expect(getPromotionState(state, "deepseek/deepseek-v4", "normal")).toMatchObject({ state: "live", since: "2026-05-10T00:00:00.000Z" });
    expect(getPromotionState(state, "unconfigured/frontier", "deep")).toMatchObject({ state: "shadow", reason: "not_configured" });
    expect(getPromotionState(state, "zhipu/glm-5.1", "normal")).toMatchObject({ state: "shadow", reason: "failure_rate_exceeded" });
    expect(getPromotionState(state, "openai/gpt-5-mini", "simple")).toMatchObject({ state: "failed", reason: "quality_regression" });
  });

  it("aggregates shadow metrics and lightweight nightly review signals", () => {
    const events = Array.from({ length: 30 }, (_, index) => event(index, {
      outcome: { success: index > 5, costUsd: 1 },
      recommendation: { expectedSuccess: index > 4, expectedCostUsd: 0.8 },
      reasonCodes: index % 2 === 0 ? ["ignored_low_confidence"] : [],
    }));

    const [metrics] = aggregateShadowEvents(events);
    const review = runLightweightPromotionReview(events);

    expect(metrics?.samples).toBe(30);
    expect(metrics?.costDelta).toBeCloseTo(-0.2, 5);
    expect(review.ignoredReasonCounts.ignored_low_confidence).toBe(15);
    expect(review.failureRates["deepseek/deepseek-v4"]).toBeCloseTo(0.2, 5);
  });
});
