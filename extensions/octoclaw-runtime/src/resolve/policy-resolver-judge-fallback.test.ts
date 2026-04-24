import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStatelessPolicyDecision } from "./policy-resolver.js";

const localJudgeConfig = {
  enabled: true,
  shadowMode: false,
  modelId: "test-local-judge",
  baseUrl: "http://localhost:19999/v1",
  apiKey: "test-key",
  timeoutMs: 1500,
  timeoutLocalMs: 800,
  minConfidence: 0.6,
  local: true,
  judgeAckEnabled: true,
} as const;

const remoteJudgeConfig = {
  enabled: true,
  modelId: "gpt-5.4-mini",
  baseUrl: "http://localhost:8317/v1",
  apiKey: "sk-local",
  timeoutMs: 8000,
  shadowMode: false,
} as const;

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function judgeResponse(route: "reply" | "delegate", confidence = 0.82): Response {
  return jsonResponse({
    choices: [{
      message: {
        content: JSON.stringify({
          route,
          confidence,
          abstain_reason: null,
          ack_text: "收到",
        }),
      },
    }],
  });
}

function routeDecisionOf(decision: unknown): Record<string, unknown> {
  return (decision as { route_decision: Record<string, unknown> }).route_decision;
}

describe("policy resolver judge timeout fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes local judge timeout with fresh lookup to delegate", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("查一下最新状态", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
        conversation_control: {
          intent_class: "fresh_live_lookup",
          require_fresh_lookup: true,
        },
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "fallback",
      judge_timeout: true,
      fallback_reason: "deterministic_hard_boundary:intent",
      final_judge_source: "timeout_fallback",
    });
    expect(decision._judge_shadow_log).toMatchObject({
      judge_timeout: true,
      fallback_reason: "deterministic_hard_boundary:intent",
      final_judge_route: "delegate",
    });
  });

  it("keeps local judge timeout for simple chat on reply", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("你好", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      judge_timeout: true,
      fallback_reason: null,
      final_judge_source: "timeout",
    });
  });

  it("does not let remote judge timeout override a valid local result", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(judgeResponse("delegate", 0.81))
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("继续", {
      metadata: {
        _dualJudgeConfig: {
          local: localJudgeConfig,
          remote: remoteJudgeConfig,
        },
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
      final_judge_source: "local",
    });
    expect(decision._judge_shadow_log).toMatchObject({
      local_judge_route: "delegate",
      final_judge_route: "delegate",
      remote_judge_result: null,
    });
  });

  it("never falls to reply for required tool need on judge timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("运行检查", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
        tool_need_hint: "required",
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      judge_timeout: true,
      fallback_reason: "deterministic_hard_boundary:tool_need",
    });
  });
});
