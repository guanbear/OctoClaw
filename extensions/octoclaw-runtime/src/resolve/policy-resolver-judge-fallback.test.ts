import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStatelessPolicyDecision } from "./policy-resolver.js";
import { policyState } from "../state/policy-state.js";

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

describe("execution coverage override intent guard", () => {
  const testKeys = [
    "intent-guard-test-session",
    "intent-guard-followup-session",
    "intent-guard-timeout-new-task",
    "intent-guard-timeout-followup",
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    for (const key of testKeys) policyState.clear(key);
  });

  afterEach(() => {
    for (const key of testKeys) policyState.clear(key);
  });

  it("does NOT force reply for new task when prior receipt exists but intent is NOT follow-up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.85),
    );

    const priorKey = "intent-guard-test-session";
    policyState.set(priorKey, {
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: priorKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });

    const decision = await resolveStatelessPolicyDecision(
      "帮我写个Python脚本转换CSV到JSON",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
          conversation_control: {
            intent_class: "undetermined",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
    });
  });

  it("forces reply for execution_followup when prior receipt exists", async () => {
    vi.useFakeTimers();
    const priorKey = "intent-guard-followup-session";

    vi.setSystemTime(Date.now() - 5_000);
    policyState.set(priorKey, {
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: priorKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });
    vi.setSystemTime(Date.now() + 5_000);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    vi.useRealTimers();
    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("does NOT force reply on timeout for new task when prior receipt exists", async () => {
    vi.useFakeTimers();
    const priorKey = "intent-guard-timeout-new-task";

    vi.setSystemTime(Date.now() - 5_000);
    policyState.set(priorKey, {
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: priorKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });
    vi.setSystemTime(Date.now() + 5_000);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("timeout", "AbortError"),
    );

    const decision = await resolveStatelessPolicyDecision(
      "帮我写个Python脚本转换CSV到JSON",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
          tool_need_hint: "required",
          conversation_control: {
            intent_class: "undetermined",
          },
        },
      },
    );

    vi.useRealTimers();
    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "fallback",
      judge_timeout: true,
    });
  });

  it("forces reply on timeout for execution_followup when prior receipt exists", async () => {
    vi.useFakeTimers();
    const priorKey = "intent-guard-timeout-followup";

    vi.setSystemTime(Date.now() - 5_000);
    policyState.set(priorKey, {
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: priorKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });
    vi.setSystemTime(Date.now() + 5_000);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("timeout", "AbortError"),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    vi.useRealTimers();
    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "fallback",
      judge_timeout: true,
    });
  });

  it("case A: execution_followup + no coverage + judge=reply → stays reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("case B: execution_followup + no coverage + judge timeout → forced reply", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("timeout", "AbortError"),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "fallback",
      judge_timeout: true,
    });
  });

  it("case C: new task + no coverage + tool_need=required → delegate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "帮我写个Python脚本转换CSV到JSON",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          tool_need_hint: "required",
          conversation_control: {
            intent_class: "undetermined",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
    });
  });

  it("case D: fresh_live_lookup + no coverage → delegate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "查一下 OpenClaw 4.22 新特性",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "fresh_live_lookup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
    });
  });

  it("execution_followup + no coverage + judge=delegate → forced reply (hard rule)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("execution_followup + no coverage + judge=reply + tool_need_hint=required → forced reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.85,
              abstain_reason: null,
              ack_text: "收到",
              tool_need_hint: "required",
            }),
          },
        }],
      }),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("execution_followup + no coverage + conversation route_hint=delegate → forced reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
            route_hint: "delegate",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("execution_followup + no coverage + duration=long → forced reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.85,
              abstain_reason: null,
              ack_text: "收到",
              duration_hint: "long",
            }),
          },
        }],
      }),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你是自己查的还是子agent查的",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("local_surface_lookup (runtime_version) with require_state_grounding still delegates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你现在啥版本",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "local_surface_lookup",
            surface_id: "runtime_version",
            route_hint: "delegate",
            lane_hint: "observe",
            require_state_grounding: true,
            require_fresh_lookup: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
    });
  });

  it("local_surface_lookup timeout fallback with require_state_grounding still delegates", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("timeout", "AbortError"),
    );

    const decision = await resolveStatelessPolicyDecision(
      "你现在啥版本",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "local_surface_lookup",
            surface_id: "runtime_version",
            route_hint: "delegate",
            lane_hint: "observe",
            require_state_grounding: true,
            require_fresh_lookup: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
    });
  });
});

describe("policy resolver WorkContract integration", () => {
  const stateKey = "agent:main:work-contract-integration";

  beforeEach(() => {
    vi.restoreAllMocks();
    policyState.clear(stateKey);
  });

  afterEach(() => {
    policyState.clear(stateKey);
  });

  it("attaches WorkContract refs to returned decision and policy state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeResponse("delegate", 0.85));

    const result = await resolveStatelessPolicyDecision(
      "帮我检查一下状态",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: stateKey,
          conversation_control: {
            intent_class: "fresh_live_lookup",
          },
        },
      },
    );

    policyState.update(stateKey, (entry) => ({
      ...entry,
      decision: result,
      canonicalSessionKey: stateKey,
      workContractId: typeof result.workContractId === "string" ? result.workContractId : undefined,
    }));

    expect(result.workContractId).toEqual(expect.stringMatching(/^wc-/u));
    expect(result.work_contract).toMatchObject({
      workContractId: result.workContractId,
      route: routeDecisionOf(result).route,
      status: "sealed",
    });
    const entry = policyState.get(stateKey);
    expect(entry?.workContractId).toBe(result.workContractId);
    expect(entry?.latestExecutionReceipt).toBeDefined();
    expect(entry?.latestExecutionReceipt?.sessionKey).toBe(stateKey);
    expect(entry?.latestExecutionReceipt?.route).toBeDefined();
    expect(entry?.latestExecutionReceipt?.dispatchExecuted).toBe(false);
    expect(entry?.latestExecutionReceipt?.delegated).toBe(false);
  });
});
