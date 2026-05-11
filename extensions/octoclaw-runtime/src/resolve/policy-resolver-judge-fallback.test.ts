import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStatelessPolicyDecision } from "./policy-resolver.js";
import { policyState } from "../state/policy-state.js";
import { buildDelegationTicketDryRun } from "../runtime-ledger/ticket-dry-run.js";

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
          complexity: route === "delegate" ? "normal" : "simple",
          complexity_confidence: 0.74,
          abstain_reason: null,
          ack_text: "收到",
          decision_bucket: route === "delegate" ? "must_delegate" : "must_reply",
          startup_cost_policy: {
            main_fast_path_allowed: route !== "delegate",
            max_wall_ms: route === "delegate" ? 0 : 20_000,
            max_tool_calls: route === "delegate" ? 0 : 1,
            escalation_triggers: ["write_or_mutation_needed"],
          },
          hard_delegate_signal: route === "delegate",
          is_followup_to_recent_execution: false,
          is_new_work: route === "delegate",
          expected_deliverable: route === "delegate" ? "delegated deliverable" : null,
          ...(route === "delegate" ? {
            scope: "local",
            tool_need_hint: "required",
            duration_hint: "medium",
          } : {
            scope: "local",
            tool_need_hint: "none",
            duration_hint: "short",
          }),
        }),
      },
    }],
  });
}

function minimalJudgeResponse(route: "reply" | "delegate", confidence = 0.82): Response {
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

function judgeSignalResponse(payload: Record<string, unknown>): Response {
  return jsonResponse({
    choices: [{
      message: {
        content: JSON.stringify({
          route: "reply",
          confidence: 0.86,
          complexity: "simple",
          complexity_confidence: 0.74,
          abstain_reason: null,
          ack_text: "收到",
          is_followup_to_recent_execution: false,
          is_new_work: false,
          expected_deliverable: null,
          reply_mode: "answer",
          delegate_role: null,
          coordination_mode_hint: "solo_worker",
          scope: "local",
          tool_need_hint: "none",
          duration_hint: "short",
          evidence_required: false,
          reason_codes: [],
          ...payload,
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

  it("keeps structured fresh lookup on budgeted main fast path when judge times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("查一下最新状态", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
        conversation_control: {
          source: "explicit_conversation_control",
          intent_class: "fresh_live_lookup",
          require_fresh_lookup: true,
        },
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      judge_timeout: true,
      final_judge_source: "timeout",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
    expect(routeDecisionOf(decision).tool_need_hint).toBe("maybe");
  });

  it("routes structured explicit delegation control to delegate when judge times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const prompt = "请委派子 agent 做一个很小的验收任务：只确认 OctoClaw 0.5.0 planner/native smoke 收到本条消息，并用一句中文总结，不需要联网。";
    const decision = await resolveStatelessPolicyDecision(prompt, {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
        conversation_control: {
          source: "explicit_conversation_control",
          explicit_delegate_request: true,
        },
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "fallback",
      judge_timeout: true,
      final_judge_source: "timeout_fallback",
      hard_delegate_signal: true,
      is_new_work: true,
      expected_deliverable: prompt,
    });
    expect(decision).toMatchObject({
      is_new_work: true,
      expected_deliverable: prompt,
    });
    expect(buildDelegationTicketDryRun({ decision, payload: { task: prompt } })).toMatchObject({
      ticket_decision: "ticket_would_issue",
      ticket_denial_reason: "",
      is_new_work: true,
      expected_deliverable: prompt,
    });
  });

  it("does not turn bare delegation wording into a hard delegate when judge times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("delegate this to a sub-agent", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      judge_timeout: true,
      final_judge_source: "timeout",
      hard_delegate_signal: false,
    });
  });

  it("rejects minimal delegate judge output without using hard prompt fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(minimalJudgeResponse("delegate", 0.7));

    const decision = await resolveStatelessPolicyDecision("delegate this to a sub-agent", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      final_judge_source: "timeout",
      hard_delegate_signal: false,
    });
    expect(decision._judge_route).toBe(null);
    const shadowLog = decision._judge_shadow_log as Record<string, unknown>;
    expect(shadowLog.judge_timeout).toBe(true);
    expect(decision._judge_failure_class).toBe("invalid_json");
  });

  it("does not route compact Chinese subagent wording by keyword when judge times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("帮我派一个子agent来调研", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      judge_timeout: true,
      final_judge_source: "timeout",
      hard_delegate_signal: false,
    });
  });

  it("keeps subagent latency probes on the judge route without keyword override", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(minimalJudgeResponse("reply", 0.9));

    const prompt = "你派一次子agent要多久呢 如果不知道就测一下";
    const decision = await resolveStatelessPolicyDecision(prompt, {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      final_judge_source: "timeout",
      hard_delegate_signal: false,
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

  it("keeps judge timeout for plain weather chat on reply", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("今天天气怎么样", {
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

  it("uses local judge result directly with single-judge path", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(judgeResponse("delegate", 0.81));

    const decision = await resolveStatelessPolicyDecision("继续", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
      final_judge_source: "local",
    });
    const shadowLog = decision._judge_shadow_log as Record<string, unknown>;
    expect(shadowLog.final_judge_route).toBe("delegate");
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
    });
    expect(String(routeDecisionOf(decision).fallback_reason)).toContain("tool_need_required");
  });

  it.each([
    "opencode codeview 不用加 ulw",
    "GLM 和 opencode 怎么分工",
    "glm 配置怎么选",
  ])("keeps model/executor discussion on reply when judge times out: %s", async (prompt) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision(prompt, {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      judge_timeout: true,
      final_judge_source: "timeout",
      hard_delegate_signal: false,
    });
  });

  it.each([
    "让 opencode 修代码",
    "派 GLM 跑测试",
    "交给子 agent 后台处理",
    "Delegate a subagent to research runtime ledger ticket issuance.",
  ])("does not use executor wording as hard delegate when judge times out: %s", async (prompt) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision(prompt, {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      judge_timeout: true,
      final_judge_source: "timeout",
      hard_delegate_signal: false,
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



  it("forces reply for normalized provenance follow-up with execution coverage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.9),
    );

    const priorKey = "agent:main:normalized-followup-covered";
    policyState.set(priorKey, {
      decision: { route_decision: { route: "reply" } },
      canonicalSessionKey: priorKey,
      toolsUsed: ["exec"],
      delegated: false,
      dispatchExecuted: false,
      updatedAt: Date.now() - 5_000,
    });

    const decision = await resolveStatelessPolicyDecision(
      "[OCTOCLAW_ACCEPTANCE] run=manual case=provenance_followup acceptance=true\n<@U0ARU7EKGCQ> 刚才这个是你自己查的，还是子 agent 查的？",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
    expect((decision.work_contract as Record<string, unknown>)).toMatchObject({
      route: "reply",
      decisionSource: "execution_coverage",
    });
  });

  it("corrects judge delegate route to reply for normalized plain chat before dispatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.9),
    );

    const decision = await resolveStatelessPolicyDecision(
      "[OCTOCLAW_ACCEPTANCE] run=manual case=plain_chat acceptance=true\n<@U0ARU7EKGCQ> 你好",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: "agent:main:plain-chat-correction",
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
    expect((decision.request as Record<string, unknown>).task).toBe("你好");
    expect(((decision.request as Record<string, unknown>).metadata as Record<string, unknown>).route_correction).toMatchObject({
      from: "delegate",
      to: "reply",
      reason: "plain_chat_pre_dispatch",
    });
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
      final_judge_source: "timeout_fallback",
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
      final_judge_source: "timeout_fallback",
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

  it("case D: fresh_live_lookup + no coverage → budgeted main fast path", async () => {
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
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
  });

  it("derives budgeted bucket from reply cost signals without trusting judge decision_bucket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeSignalResponse({
      scope: "remote",
      tool_need_hint: "maybe",
      duration_hint: "short",
      evidence_required: true,
    }));

    const decision = await resolveStatelessPolicyDecision(
      "给我 2026.4.29 和 2026.4.21 两个版本差异的五句摘要，只读即可。",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
    expect(routeDecisionOf(decision).reason_codes as string[]).toEqual(
      expect.arrayContaining([
        "startup_cost_derived_from_route_cost_signals",
        "judge_cost_scope:remote",
        "judge_evidence_required",
      ]),
    );
  });

  it("ignores judge decision_bucket telemetry for high-confidence simple replies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeSignalResponse({
      decision_bucket: "budgeted_main_then_delegate",
      startup_cost_policy: { main_fast_path_allowed: true, max_wall_ms: 30_000 },
      scope: "local",
      tool_need_hint: "none",
      duration_hint: "short",
      evidence_required: false,
    }));

    const decision = await resolveStatelessPolicyDecision("用一句话解释 NIH 是什么", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      decision_bucket: "must_reply",
      hard_delegate_signal: false,
    });
    expect(routeDecisionOf(decision).reason_codes as string[]).toEqual(
      expect.arrayContaining(["judge_decision_bucket_telemetry:budgeted_main_then_delegate"]),
    );
  });

  it("uses low-confidence reply route as budget signal without delegate authority", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeSignalResponse({
      confidence: 0,
      ack_text: null,
      scope: "local",
      tool_need_hint: "none",
      duration_hint: "short",
      evidence_required: false,
    }));

    const decision = await resolveStatelessPolicyDecision(
      "<@U0ARU7EKGCQ> OpenClaw 2026.4.29 相比 2026.4.21 有哪些 release 变化？也看一下 OctoClaw 文档里 PC13 Slack delivery port 记录的字段，最后用 5 句中文总结。只读即可。",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      final_judge_source: "no_judge",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
    expect(routeDecisionOf(decision).reason_codes as string[]).toEqual(
      expect.arrayContaining([
        "judge_route_intent:reply",
        "judge_low_confidence_budgeted",
      ]),
    );
  });

  it("derives must_delegate from an actionable two-class delegate judge without decision_bucket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeSignalResponse({
      route: "delegate",
      confidence: 0.88,
      is_new_work: true,
      expected_deliverable: "review summary",
      delegate_role: "review",
      scope: "local",
      tool_need_hint: "maybe",
      duration_hint: "medium",
      evidence_required: true,
    }));

    const decision = await resolveStatelessPolicyDecision("做一次只读 review 并汇总风险", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
      decision_bucket: "must_delegate",
      hard_delegate_signal: true,
    });
    expect(routeDecisionOf(decision).reason_codes as string[]).toEqual(
      expect.arrayContaining(["hard_delegate:judge_actionable_delegate"]),
    );
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

  it("does not let legacy judge tool_need_hint override an active reply route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.85,
              complexity: "simple",
              complexity_confidence: 0.74,
              abstain_reason: null,
              ack_text: "收到",
              tool_need_hint: "required",
              scope: "local",
            }),
          },
        }],
      }),
    );

    const decision = await resolveStatelessPolicyDecision(
      "请直接在主会话查一下本机 OpenClaw 版本和 npm 最新版本，不要委派子 agent；用一行回答。",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "local_surface_lookup",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      hard_delegate_signal: false,
    });
    expect((decision._judge_shadow_log as Record<string, unknown>).validator_override_reasons ?? [])
      .not.toContain("validator:hard_delegate_signal→delegate(tool_need_required)");
  });

  it("execution_followup + no coverage + judge=reply + tool_need_hint=required → forced reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.85,
              complexity: "simple",
              complexity_confidence: 0.74,
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

  it("preserves delegate when main route_hint and judge agree during implementation follow-up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.9),
    );

    const decision = await resolveStatelessPolicyDecision(
      "好的，弄吧，启动时间你也看下什么时候合适",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
        routeHint: {
          route_hint: "delegate",
          requested_route: "delegate",
          work_type: "code",
          phase: "implement",
          confidence: 0.95,
          source: "main_agent",
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
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
              complexity: "simple",
              complexity_confidence: 0.74,
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

  it("local_surface_lookup (runtime_version) with require_state_grounding stays budgeted main first", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.85),
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
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
  });

  it("local_surface_lookup timeout fallback with require_state_grounding stays budgeted main first", async () => {
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
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
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

  it("prompt-only live lookup follows judge without regex validator authority", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "请查一下 OpenClaw 4.21 最近一次发布说明",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
  });

  it("structured live lookup cannot override judge reply to delegate by itself", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "请查一下 OpenClaw 4.21 最近一次发布说明",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "fresh_live_lookup",
            route_hint: "delegate",
            require_fresh_lookup: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
  });

  it("route_hint delegate stays advisory when deterministic live lookup has no hard signal", async () => {
    const decision = await resolveStatelessPolicyDecision(
      "openclaw最新版的新特性是啥",
      {
        metadata: {
          session_key: "agent:main:route-hint-live-lookup",
        },
        routeHint: {
          route_hint: "delegate",
          requested_route: "delegate",
          work_type: "research",
          confidence: 0.9,
          source: "main_agent",
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      dispatch_required: false,
      decision_bucket: "budgeted_main_then_delegate",
      hard_delegate_signal: false,
    });
    expect(decision.route_hint_policy).toMatchObject({
      trusted: false,
      advisory_only: true,
      source: "main_agent",
    });
    expect(decision.tool_policy).toMatchObject({
      must_delegate_via: "",
      allow_direct_tools: true,
    });
  });

  it("deterministic session fallback control cannot override judge reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "openclaw 4.21 有啥新特性",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "session_resolver_fallback",
            intent_class: "fresh_live_lookup",
            route_hint: "delegate",
            require_fresh_lookup: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
  });

  it("queued busy wrapper is unwrapped before policy resolution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.90),
    );

    const decision = await resolveStatelessPolicyDecision(
      "[Queued messages while agent was busy]\nSystem: 22:51: guanbear: 你好",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
    expect((decision.request as { task: string }).task).toBe("你好");
  });

  it("Slack thread history wrapper is unwrapped before policy resolution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.90),
    );

    const decision = await resolveStatelessPolicyDecision(
      `[Thread history - for context]
[Slack guanbear] 八爪鱼状态
[Slack OpenClaw Macmini] 已判定为委派任务，正在准备派发。

System: [2026-04-27 23:25 GMT+8] Slack DM from guanbear: 你都已经查过了 并且给过架构了 你忘了吗

Conversation info (untrusted metadata):
\`\`\`json
{"reply_to_id":"1777303251.997259"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"name":"guanbear"}
\`\`\`

你都已经查过了 并且给过架构了 你忘了吗`,
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
    expect((decision.request as { task: string }).task).toBe("你都已经查过了 并且给过架构了 你忘了吗");
  });

  it("simple chat prompt stays reply when judge returns reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.90),
    );

    const decision = await resolveStatelessPolicyDecision(
      "在吗",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("structured execution followup with coverage stays reply despite lookup wording", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("reply", 0.85),
    );

    const decision = await resolveStatelessPolicyDecision(
      "查一下刚才那个任务的状态",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "execution_followup",
          },
          execution_layer: {
            supports_provenance_reply: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
    });
  });

  it("prompt-only status panel follows judge without regex validator authority", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "显示任务状态面板，包含模型、耗时、结果位置",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
      final_judge_source: "local",
    });
  });

  it("structured status panel overrides judge delegate to reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "显示任务状态面板，包含模型、耗时、结果位置",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "local_surface_lookup",
            route_hint: "reply",
            status_followup: true,
            surface_id: "octoclaw_task_status_panel",
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
  });

  it("fresh live lookup with stale delegated receipt still allows dispatch", async () => {
    vi.useFakeTimers();
    const priorKey = "intent-guard-fresh-lookup-prior-delegate";
    policyState.clear(priorKey);
    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
    policyState.set(priorKey, {
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
      },
      canonicalSessionKey: priorKey,
      delegated: true,
      dispatchExecuted: false,
      spawnExecuted: false,
      resultMaterialized: false,
      latestExecutionReceipt: {
        turnId: "turn-prior-delegate-unknown",
        sessionKey: priorKey,
        route: "delegate",
        delegated: true,
        dispatchExecuted: false,
        spawnExecuted: false,
        workContractId: "wc-prior-delegate-unknown",
        delegateTaskId: null,
        nativeTaskId: "task-prior-native",
        nativeFlowId: "flow-prior-native",
        childSessionKey: null,
        childSessionId: null,
        childRunId: null,
        nativeFlowRevision: null,
        nativeFlowExpectedRevision: null,
        nativeFlowMutation: null,
        nativeFlowMutationApplied: null,
        nativeFlowMutationError: null,
        workerPool: "octoclaw-worker",
        toolsUsed: [],
        resultMaterialized: false,
        deliveryStatus: null,
        durationMs: 0,
        outcome: "unknown",
        completedAt: Date.now() - 5_000,
        executionCoverage: null,
        executionSupportsProvenanceReply: true,
        executionSupportsStatusReply: true,
        executionRequiresControlPlaneRefresh: true,
        memoryCoverage: null,
        authority: "execution_wins",
        parentContextTokensAdded: 0,
        resultPacketTokens: 0,
        artifactReopenCount: 0,
      },
      updatedAt: Date.now() - 5_000,
    });
    vi.setSystemTime(new Date("2026-04-29T12:00:10.000Z"));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "openclaw最新版的新特性是啥",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: priorKey,
          judge_session_keys: [priorKey],
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "fresh_live_lookup",
            route_hint: "delegate",
            require_fresh_lookup: true,
          },
        },
      },
    );

    vi.useRealTimers();
    expect(routeDecisionOf(decision)).toMatchObject({
      route: "delegate",
      route_source: "judge",
      final_judge_source: "local",
      dispatch_required: true,
    });
    expect(decision.tool_policy).toMatchObject({
      must_delegate_via: "octoclaw_dispatch",
      delegate_first: true,
      allowed_control_tools: expect.arrayContaining(["octoclaw_dispatch"]),
    });
    expect((decision.tool_policy as Record<string, unknown>).block_tool_patterns).not.toContain("octoclaw_dispatch");
    expect((decision.work_contract as Record<string, unknown>)).toMatchObject({
      route: "delegate",
    });
  });

  it("structured provenance query with execution coverage overrides judge delegate to reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      judgeResponse("delegate", 0.88),
    );

    const decision = await resolveStatelessPolicyDecision(
      "刚才那任务判定是啥，证据在哪",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "execution_followup",
            provenance_followup: true,
          },
          execution_layer: {
            supports_provenance_reply: true,
          },
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "judge",
      final_judge_source: "local",
    });
  });

  it("timeout with prompt-only status panel uses baseline reply without keyword force", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("timeout", "AbortError"),
    );

    const decision = await resolveStatelessPolicyDecision(
      "显示任务状态面板，包含模型、耗时、结果位置",
      {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {},
        },
      },
    );

    expect(routeDecisionOf(decision)).toMatchObject({
      route: "reply",
      route_source: "rule",
      judge_timeout: true,
      final_judge_source: "timeout",
    });
  });
});

describe("SR-P1 startup-cost-aware delegation tightening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("false-delegate: advisory signals must not force delegate", () => {
    it("bare opencode mention without action stays reply on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("opencode 是什么", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("bare GLM model discussion stays reply on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("GLM 模型有哪些参数", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("code/test configuration discussion stays reply on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("测试怎么配置比较合理", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        hard_delegate_signal: false,
      });
    });

    it("validation/review process discussion stays reply on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("验证和审核流程怎么设计比较合理", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        hard_delegate_signal: false,
      });
    });

    it("fast_first_response alone does not force delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("查一下状态", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          fast_first_response: true,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        hard_delegate_signal: false,
      });
      expect((routeDecisionOf(decision).reason_codes as string[])).toEqual(
        expect.arrayContaining(["advisory:fast_first_response"]),
      );
    });

    it("fresh_live_lookup without hard evidence stays budgeted with hard_delegate_signal=false", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        judgeResponse("reply", 0.85),
      );

      const decision = await resolveStatelessPolicyDecision("查一下最新版本号", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            intent_class: "fresh_live_lookup",
            require_fresh_lookup: true,
          },
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        decision_bucket: "budgeted_main_then_delegate",
        hard_delegate_signal: false,
      });
    });

    it("route_hint=delegate without hard evidence stays budgeted with hard_delegate_signal=false", async () => {
      const decision = await resolveStatelessPolicyDecision("查一下版本号", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          session_key: "agent:main:srp1-route-hint-no-evidence",
        },
        routeHint: {
          route_hint: "delegate",
          requested_route: "delegate",
          work_type: "research",
          confidence: 0.8,
          source: "main_agent",
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        decision_bucket: "budgeted_main_then_delegate",
        hard_delegate_signal: false,
      });
    });
  });

  describe("false-reply: structured evidence still delegates", () => {
    it("workType=code forces delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("帮我实现这个功能", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          workType: "code",
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        judge_timeout: true,
        decision_bucket: "must_delegate",
        hard_delegate_signal: true,
      });
      expect((routeDecisionOf(decision).reason_codes as string[])).toEqual(
        expect.arrayContaining([expect.stringContaining("hard_delegate:work_type_code")]),
      );
    });

    it("natural test execution wording does not force delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("跑一下测试看看结果", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("natural build validation wording does not force delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("请验证构建并告诉我结果", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("executor mention does not delegate without structured control", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("让 opencode 跑测试并汇总结果", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("multi-step tool wording does not force delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("先读日志再跑测试，最后告诉我失败原因", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "reply",
        judge_timeout: true,
        final_judge_source: "timeout",
        hard_delegate_signal: false,
      });
    });

    it("duration_hint=long forces delegate on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("分析一下系统架构", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          duration_hint: "long",
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        judge_timeout: true,
        decision_bucket: "must_delegate",
        hard_delegate_signal: true,
      });
      expect((routeDecisionOf(decision).reason_codes as string[])).toEqual(
        expect.arrayContaining([expect.stringContaining("hard_delegate:duration_long")]),
      );
    });

    it("tool_need_hint=required still delegates on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("验证构建结果", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          tool_need_hint: "required",
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        judge_timeout: true,
        hard_delegate_signal: true,
      });
    });

    it("structured explicit_delegate_request still delegates on judge timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

      const decision = await resolveStatelessPolicyDecision("查一下状态", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            explicit_delegate_request: true,
          },
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        judge_timeout: true,
        hard_delegate_signal: true,
      });
    });

    it("active judge must_delegate output still delegates", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        judgeResponse("delegate", 0.88),
      );

      const decision = await resolveStatelessPolicyDecision("帮我重构一下代码结构", {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        route_source: "judge",
        final_judge_source: "local",
        hard_delegate_signal: true,
      });
    });

    it("repairs inconsistent delegate judge output that marks obvious new work as not new", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        judgeSignalResponse({
          route: "delegate",
          confidence: 0.88,
          decision_bucket: "must_delegate",
          hard_delegate_signal: true,
          is_followup_to_recent_execution: false,
          is_new_work: false,
          expected_deliverable: null,
          tool_need_hint: "required",
          duration_hint: "medium",
          scope: "local",
        }),
      );

      const prompt = "请明确委派子 agent 做一个只读检查，最后给验收摘要。";
      const decision = await resolveStatelessPolicyDecision(prompt, {
        metadata: {
          _judgeFastConfig: localJudgeConfig,
          conversation_control: {
            source: "explicit_conversation_control",
            explicit_delegate_request: true,
          },
        },
      });

      expect(routeDecisionOf(decision)).toMatchObject({
        route: "delegate",
        decision_bucket: "must_delegate",
        is_new_work: true,
        expected_deliverable: prompt,
      });
      expect(decision).toMatchObject({
        is_new_work: true,
        expected_deliverable: prompt,
      });
      expect(buildDelegationTicketDryRun({ decision, payload: { task: prompt } })).toMatchObject({
        ticket_decision: "ticket_would_issue",
        is_new_work: true,
      });
    });
  });
});
