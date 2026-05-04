import { afterEach, describe, expect, it, vi } from "vitest";

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

function routeDecisionOf(decision: unknown): { route: string } {
  return (decision as { route_decision: { route: string } }).route_decision;
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

describe("llm judge single-judge mode", () => {
  afterEach(() => {
    delete process.env.OCTOCLAW_JUDGE_FAST;
    delete process.env.OCTOCLAW_JUDGE_DEBUG;
    delete process.env.OCTOCLAW_JUDGE_OLLAMA_KEEP_ALIVE;
    vi.restoreAllMocks();
  });

  it("resolves single judge from _judgeFastConfig and routes correctly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            route: "delegate",
            confidence: 0.84,
            abstain_reason: null,
            ack_text: "收到",
            decision_bucket: "must_delegate",
            startup_cost_policy: {
              main_fast_path_allowed: false,
              max_wall_ms: 0,
              max_tool_calls: 0,
              escalation_triggers: ["write_or_mutation_needed"],
            },
            hard_delegate_signal: true,
            is_followup_to_recent_execution: false,
            is_new_work: true,
            expected_deliverable: "script fix",
            scope: "local",
            tool_need_hint: "required",
            duration_hint: "medium",
          }),
        },
      }],
    }));

    const decision = await resolveStatelessPolicyDecision("写一个脚本修复这个问题", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision).route).toBe("delegate");
    expect(decision._judge_route).toBe("delegate");
    const shadowLog = decision._judge_shadow_log as Record<string, unknown>;
    expect(shadowLog.final_judge_route).toBe("delegate");
  });

  it("keeps single-judge backward compatibility when no remote config exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            route: "delegate",
            confidence: 0.84,
            abstain_reason: null,
            ack_text: "收到",
            decision_bucket: "must_delegate",
            startup_cost_policy: {
              main_fast_path_allowed: false,
              max_wall_ms: 0,
              max_tool_calls: 0,
              escalation_triggers: ["write_or_mutation_needed"],
            },
            hard_delegate_signal: true,
            is_followup_to_recent_execution: false,
            is_new_work: true,
            expected_deliverable: "script fix",
            scope: "local",
            tool_need_hint: "required",
            duration_hint: "medium",
          }),
        },
      }],
    }));

    const decision = await resolveStatelessPolicyDecision("写一个脚本修复这个问题", {
      metadata: {
        _judgeFastConfig: localJudgeConfig,
      },
    });

    expect(routeDecisionOf(decision).route).toBe("delegate");
    expect(decision._judge_route).toBe("delegate");
    const shadowLog = decision._judge_shadow_log as Record<string, unknown>;
    expect(shadowLog.final_judge_route).toBe("delegate");
  });

  it("keeps Ollama native judge resident and caps generation", async () => {
    process.env.OCTOCLAW_JUDGE_OLLAMA_KEEP_ALIVE = "45m";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      message: {
        content: JSON.stringify({
          route: "reply",
          confidence: 0.86,
          is_followup_to_recent_execution: false,
          is_new_work: false,
          expected_deliverable: null,
          reply_mode: "answer",
          delegate_role: null,
          coordination_mode_hint: "solo_worker",
          complexity: "simple",
          scope: "unknown",
          tool_need_hint: "none",
          duration_hint: "short",
          evidence_required: false,
          reason_codes: ["simple_reply"],
        }),
      },
      prompt_eval_count: 280,
      eval_count: 64,
    }));

    const decision = await resolveStatelessPolicyDecision("你好", {
      metadata: {
        _judgeFastConfig: {
          ...localJudgeConfig,
          baseUrl: "http://127.0.0.1:11434/v1",
          timeoutLocalMs: 1200,
        },
      },
    });

    expect(routeDecisionOf(decision).route).toBe("reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(request.keep_alive).toBe("45m");
    expect(request.think).toBe(false);
    expect(request.format).toBe("json");
    expect(request.options).toEqual({
      temperature: 0,
      num_predict: 192,
    });
  });

  it("requires route hint when judge fast config is absent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const decision = await resolveStatelessPolicyDecision("你好", {
      metadata: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((decision.route_decision as Record<string, unknown>).route).toBe("reply");
    expect((decision.route_hint_policy as Record<string, unknown>).required).toBe(true);
    expect(decision._route_hint_required).toBe(true);
    expect((decision.route_decision as Record<string, unknown>).final_judge_source).toBe("no_judge");
  });

});
