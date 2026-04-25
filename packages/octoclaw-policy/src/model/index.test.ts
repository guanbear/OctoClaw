import { describe, expect, it } from "vitest";
import {
  BASELINE_MODEL_PROFILE_MAP,
  decideBackend,
  decideExecutionProfile,
  decideModelProfile,
  evaluateShadowPromotion,
  compareShadowRecommendationToActual,
  recommendModelProfileShadow,
  resolveModelId,
  type ShadowModelRecommendation,
  V1_MODEL_PROFILE_MAP,
} from "./index.js";

describe("model policy", () => {
  it("maps all 9 profiles correctly", () => {
    expect(V1_MODEL_PROFILE_MAP).toEqual({
      judge_fast: "minimax-portal/MiniMax-M2.7",
      observer_probe: "minimax-portal/MiniMax-M2.7",
      direct_main: "zhipu/GLM-5.1",
      worker_default: "zhipu/GLM-5.1",
      worker_research: "zhipu/GLM-5.1",
      worker_code_normal: "zhipu/GLM-5.1",
      worker_code_deep: "omniroute/cx/gpt-5.4",
      worker_review: "omniroute/cx/gpt-5.4",
      worker_deep: "omniroute/cx/gpt-5.4",
    });
  });

  it("resolves specific model ids", () => {
    expect(resolveModelId("judge_fast")).toBe("minimax-portal/MiniMax-M2.7");
    expect(resolveModelId("worker_code_deep")).toBe("omniroute/cx/gpt-5.4");
    expect(resolveModelId("direct_main")).toBe("zhipu/GLM-5.1");
  });

  it("chooses code profile by workspace mode", () => {
    expect(decideModelProfile("worker_code", "isolated_worktree").modelProfile).toBe("worker_code_normal");
    expect(decideModelProfile("worker_code", "shared_workspace").modelProfile).toBe("worker_code_deep");
  });

  it("separates backend from execution profile", () => {
    expect(decideBackend("main_reply").backend).toBe("openclaw-native");
    expect(decideExecutionProfile("observer_probe").executionProfile).toBe("observer");
    expect(decideExecutionProfile("worker_research").executionProfile).toBe("worker");
  });

  it("keeps a fixed baseline profile map for shadow comparison", () => {
    expect(BASELINE_MODEL_PROFILE_MAP).toEqual(V1_MODEL_PROFILE_MAP);
  });

  it("emits shadow recommendation without changing live profile", () => {
    const recommendation = recommendModelProfileShadow({
      liveProfile: "direct_main",
      lane: "reply",
      qualityRisk: "low",
    });

    expect(recommendation).toMatchObject({
      mode: "shadow",
      liveProfile: "direct_main",
      recommendedProfile: "judge_fast",
      promotionAllowed: false,
      rollbackTarget: "direct_main",
    });
    expect(recommendation.liveModelId).toBe(resolveModelId("direct_main"));
  });

  it("allows promotion only when gate overall passes and keeps rollback target", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(evaluateShadowPromotion({ recommendation, gateOverall: "unknown" })).toEqual({
      promotionAllowed: false,
      rollbackTarget: "direct_main",
      reason: "gate_unknown_blocks_promotion",
    });
    expect(evaluateShadowPromotion({ recommendation, gateOverall: "pass" })).toEqual({
      promotionAllowed: true,
      rollbackTarget: "direct_main",
      reason: "gate_pass_allows_manual_promotion",
    });
  });

  it("compares shadow recommendation with actual live result without changing live path", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });
    const comparison = compareShadowRecommendationToActual({ recommendation, actualProfile: "direct_main" });

    expect(comparison).toMatchObject({
      actualProfile: "direct_main",
      matchedRecommendation: false,
      livePathChanged: false,
    });
    expect(comparison.actualModelId).toBe(resolveModelId("direct_main"));
  });
});

describe("Phase C acceptance: model-on-demand shadow rollout", () => {
  it("BASELINE_MODEL_PROFILE_MAP has exactly 9 profiles", () => {
    expect(Object.keys(BASELINE_MODEL_PROFILE_MAP).sort()).toEqual([
      "direct_main",
      "judge_fast",
      "observer_probe",
      "worker_code_deep",
      "worker_code_normal",
      "worker_deep",
      "worker_default",
      "worker_research",
      "worker_review",
    ]);
  });

  it("shadow recommendation does not change live profile", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(recommendation.liveProfile).toBe("direct_main");
    expect(recommendation.promotionAllowed).toBe(false);
  });

  it("shadow recommendation for reply lane with low risk suggests judge_fast", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(recommendation.recommendedProfile).toBe("judge_fast");
    expect(recommendation.recommendedProfile).not.toBe(recommendation.liveProfile);
  });

  it("shadow recommendation for delegate lane keeps live profile", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "worker_code_deep", lane: "delegate", qualityRisk: "low" });

    expect(recommendation.recommendedProfile).toBe(recommendation.liveProfile);
  });

  it("shadow recommendation always has mode=\"shadow\"", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "worker_review", lane: "flow", qualityRisk: "high" });

    expect(recommendation.mode).toBe("shadow");
  });

  it("shadow recommendation always has rollbackTarget", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "worker_research", lane: "delegate" });

    expect(recommendation.rollbackTarget).toBe(recommendation.liveProfile);
  });

  it("evaluateShadowPromotion blocks on gate fail", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(evaluateShadowPromotion({ recommendation, gateOverall: "fail" }).promotionAllowed).toBe(false);
  });

  it("evaluateShadowPromotion blocks on gate unknown", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(evaluateShadowPromotion({ recommendation, gateOverall: "unknown" }).promotionAllowed).toBe(false);
  });

  it("evaluateShadowPromotion allows on gate pass", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" });

    expect(evaluateShadowPromotion({ recommendation, gateOverall: "pass" }).promotionAllowed).toBe(true);
  });

  it("evaluateShadowPromotion preserves rollbackTarget", () => {
    const recommendation = recommendModelProfileShadow({ liveProfile: "worker_default", lane: "delegate" });

    expect(evaluateShadowPromotion({ recommendation, gateOverall: "pass" }).rollbackTarget).toBe("worker_default");
    expect(evaluateShadowPromotion({ recommendation, gateOverall: "fail" }).rollbackTarget).toBe("worker_default");
  });

  it("no online self-tuning — shadow is advisory only", () => {
    const recommendations: ShadowModelRecommendation[] = [
      recommendModelProfileShadow({ liveProfile: "direct_main", lane: "reply", qualityRisk: "low" }),
      recommendModelProfileShadow({ liveProfile: "worker_code_deep", lane: "delegate", qualityRisk: "low" }),
      recommendModelProfileShadow({ liveProfile: "worker_review", lane: "flow", qualityRisk: "high" }),
    ];

    expect(recommendations.every((recommendation) => recommendation.promotionAllowed === false)).toBe(true);
  });

  it("resolveModelId is deterministic", () => {
    expect(resolveModelId("worker_code_deep")).toBe(resolveModelId("worker_code_deep"));
    expect(resolveModelId("judge_fast")).toBe(resolveModelId("judge_fast"));
  });
});
