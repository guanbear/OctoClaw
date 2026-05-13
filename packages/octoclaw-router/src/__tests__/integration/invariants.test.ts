import { describe, expect, it, vi } from "vitest";

import {
  applyRouterRecommendationForAgent,
  hotPathAllowsNetworkCall,
  isolateShadowFailure,
  isRouterDataPathLocal,
  recoverFromJudgeFailure,
  renderModelFooter,
} from "../../invariants/index.js";

describe("router invariants RT-I-001..006", () => {
  it("RT-I-001 renders the delegated model in IM footer", () => {
    expect(renderModelFooter("openai/gpt-5-mini")).toContain("Model: openai/gpt-5-mini");
  });

  it("RT-I-002 never silently switches the main agent model", () => {
    expect(applyRouterRecommendationForAgent({
      agentRole: "main",
      currentModel: "anthropic/claude-opus-4",
      recommendedModel: "anthropic/claude-sonnet",
    })).toEqual({
      actualModel: "anthropic/claude-opus-4",
      suggestedModel: "anthropic/claude-sonnet",
      applied: false,
    });
    expect(applyRouterRecommendationForAgent({
      agentRole: "subagent",
      currentModel: "anthropic/claude-opus-4",
      recommendedModel: "anthropic/claude-sonnet",
    }).actualModel).toBe("anthropic/claude-sonnet");
  });

  it("RT-I-003 isolates shadow emission failure from live route", () => {
    const decision = { route: "delegate", model: "openai/gpt-5.5" };
    const emit = vi.fn(() => {
      throw new Error("disk full");
    });

    expect(isolateShadowFailure(decision, emit)).toBe(decision);
  });

  it("RT-I-004 recovers from judge failure with fallback output", () => {
    expect(recoverFromJudgeFailure({ prompt: "hi", sessionKey: "s", runtimeSignals: {} }, new Error("parse"))).toEqual({
      route: "reply",
      confidence: 0.5,
      complexity: "normal",
    });
  });

  it("RT-I-005 allows no external network call in the user-message hot path", () => {
    expect(hotPathAllowsNetworkCall("local_judge_endpoint")).toBe(true);
    expect(hotPathAllowsNetworkCall("https://api.openrouter.ai/api/v1/models")).toBe(false);
  });

  it("RT-I-006 keeps routing data paths local in V1", () => {
    expect(isRouterDataPathLocal("~/.openclaw/octoclaw/cost.sqlite")).toBe(true);
    expect(isRouterDataPathLocal("https://telemetry.example/upload")).toBe(false);
  });
});
