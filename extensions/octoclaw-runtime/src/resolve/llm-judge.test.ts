import { afterEach, describe, expect, it, vi } from "vitest";

import type { DualJudgeConfig, JudgeInput, JudgeOutput } from "@octoclaw/policy/judge-schema";

import {
  callRemoteJudge,
  resolveDualJudgeConfig,
  resolveDualJudgeConfigFromEnv,
  shouldEscalate,
} from "./llm-judge.js";
import { resolveStatelessPolicyDecision } from "./policy-resolver.js";

const localJudgeConfig = {
  enabled: true,
  shadowMode: false,
  modelId: "qwen3-judge:0.6b-q4km",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
  timeoutMs: 1500,
  timeoutLocalMs: 800,
  minConfidence: 0.6,
  local: true,
  judgeAckEnabled: true,
} as const;

const remoteJudgeConfig: DualJudgeConfig["remote"] = {
  enabled: true,
  modelId: "gpt-5.4-mini",
  baseUrl: "http://localhost:8317/v1",
  apiKey: "sk-local",
  timeoutMs: 8000,
  shadowMode: true,
};

const escalationConfig: DualJudgeConfig["escalation"] = {
  minConfidence: 0.6,
  alwaysEscalateRiskFlags: ["high_risk_write"],
  maxLatencyMs: 4000,
};

type DualJudgeConfigOverrides = {
  local?: Partial<DualJudgeConfig["local"]>;
  remote?: Partial<DualJudgeConfig["remote"]>;
  escalation?: Partial<DualJudgeConfig["escalation"]>;
};

function buildDualJudgeConfig(overrides: DualJudgeConfigOverrides = {}): DualJudgeConfig {
  const localOverrides = overrides.local ?? {};
  const remoteOverrides = overrides.remote ?? {};
  const escalationOverrides = overrides.escalation ?? {};
  return {
    local: {
      ...localJudgeConfig,
      ...localOverrides,
    },
    remote: {
      ...remoteJudgeConfig,
      ...remoteOverrides,
    },
    escalation: {
      ...escalationConfig,
      ...escalationOverrides,
    },
  };
}

function routeDecisionOf(decision: unknown): { route: string } {
  return (decision as { route_decision: { route: string } }).route_decision;
}

function buildJudgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    userMessage: "继续",
    availableActions: ["spawn_work"],
    availableTargets: ["current_session"],
    contextPacket: {
      core: { current_turn: "继续" },
    },
    ...overrides,
  };
}

function buildJudgeResult(overrides: Partial<JudgeOutput> = {}): JudgeOutput {
  return {
    route: "delegate",
    confidence: 0.8,
    abstainReason: null,
    ackText: "收到",
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function textErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    text: async () => message,
  } as Response;
}

describe("llm judge dual mode", () => {
  afterEach(() => {
    delete process.env.OCTOCLAW_JUDGE_FAST;
    delete process.env.OCTOCLAW_JUDGE_REMOTE;
    delete process.env.OCTOCLAW_JUDGE_DEBUG;
    vi.restoreAllMocks();
  });

  it("resolves dual judge config from metadata", () => {
    const config = resolveDualJudgeConfig({
      _judgeFastConfig: {
        enabled: true,
        local: true,
        modelId: "qwen3-judge:0.6b-q4km",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        timeoutLocalMs: 800,
      },
      _remoteJudgeConfig: {
        enabled: true,
        modelId: "gpt-5.4-mini",
        baseUrl: "http://localhost:8317/v1",
        apiKey: "sk-local",
        timeoutMs: 8000,
        shadowMode: true,
      },
    });

    expect(config).not.toBeNull();
    expect(config?.local.local).toBe(true);
    expect(config?.remote.enabled).toBe(true);
    expect(config?.remote.shadowMode).toBe(true);
  });

  it("resolves dual judge config from env", () => {
    process.env.OCTOCLAW_JUDGE_FAST = JSON.stringify({
      enabled: true,
      local: true,
      modelId: "qwen3-judge:0.6b-q4km",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      timeoutLocalMs: 800,
    });
    process.env.OCTOCLAW_JUDGE_REMOTE = JSON.stringify({
      enabled: true,
      modelId: "gpt-5.4-mini",
      baseUrl: "http://localhost:8317/v1",
      apiKey: "sk-local",
      timeoutMs: 8000,
      shadowMode: true,
    });

    const config = resolveDualJudgeConfigFromEnv();
    expect(config?.local.modelId).toBe("qwen3-judge:0.6b-q4km");
    expect(config?.remote.modelId).toBe("gpt-5.4-mini");
  });

  it("covers all seven escalation triggers", () => {
    const local = buildJudgeResult();

    expect(shouldEscalate(
      buildJudgeResult({ confidence: 0.42 }),
      escalationConfig,
      { task: "做吧" },
    )).toBe("low_confidence");

    expect(shouldEscalate(
      buildJudgeResult({ confidence: 0.9, riskFlags: ["high_risk_write"] }),
      escalationConfig,
      { task: "deploy" },
    )).toBe("high_risk_write");

    expect(shouldEscalate(local, escalationConfig, { task: "继续" })).toBe("short_turn_context_dependent");
    expect(shouldEscalate(local, escalationConfig, { task: "keep going", active_intents: ["a", "b"] })).toBe("multiple_active_intents");
    expect(shouldEscalate(buildJudgeResult({ scope: "unknown" }), escalationConfig, { task: "long enough", canSafelyClarify: false })).toBe("scope_unknown");
    expect(shouldEscalate(buildJudgeResult({ role: "observer_probe", complexityBand: "deep" }), escalationConfig, { task: "long enough" })).toBe("unstable_classification");
    expect(shouldEscalate(local, escalationConfig, { task: "long enough", validator_conflict: true })).toBe("validator_conflict");
  });

  it("calls remote judge and parses adjudication fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            route: "delegate",
            confidence: 0.88,
            abstain_reason: null,
            ack_text: "继续处理",
            override_recommendation: "accept_local",
            adjudication_reason: "local decision is coherent",
            confidence_delta: 0.08,
          }),
        },
      }],
    }));

    const result = await callRemoteJudge(
      buildJudgeInput(),
      buildJudgeResult(),
      "short_turn_context_dependent",
      buildDualJudgeConfig(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result?.override_recommendation).toBe("accept_local");
    expect(result?.adjudication_reason).toContain("coherent");
    expect(result?.confidence_delta).toBe(0.08);
  });

  it("preserves local result when remote judge times out", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "delegate",
              confidence: 0.81,
              abstain_reason: null,
              ack_text: "收到",
            }),
          },
        }],
      }))
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const decision = await resolveStatelessPolicyDecision("继续", {
      metadata: {
        _dualJudgeConfig: buildDualJudgeConfig({
          remote: { shadowMode: false },
        }),
      },
    });

    expect(routeDecisionOf(decision).route).toBe("delegate");
    expect(decision._judge_route).toBe("delegate");
    expect(decision._judge_shadow_log).toMatchObject({
      local_judge_route: "delegate",
      final_judge_route: "delegate",
      local_judge_confidence: 0.81,
      final_judge_confidence: 0.81,
      remote_override_applied: false,
      remote_judge_result: null,
      judge_escalation_reason: "short_turn_context_dependent",
    });
  });

  it("preserves local result in shadow mode when remote recommends override", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "delegate",
              confidence: 0.78,
              abstain_reason: null,
              ack_text: "收到",
            }),
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.93,
              abstain_reason: null,
              ack_text: "我来答",
              override_recommendation: "override_local",
              adjudication_reason: "simple enough to reply directly",
            }),
          },
        }],
      }));

    const decision = await resolveStatelessPolicyDecision("继续", {
      metadata: {
        _dualJudgeConfig: buildDualJudgeConfig({
          remote: { shadowMode: true },
        }),
      },
    });

    expect(routeDecisionOf(decision).route).toBe("delegate");
    expect(decision._judge_route).toBe("delegate");
    expect(decision._judge_shadow_log).toMatchObject({
      local_judge_route: "delegate",
      final_judge_route: "delegate",
      remote_override_applied: false,
      remote_judge_result: expect.objectContaining({
        route: "reply",
        override_recommendation: "override_local",
      }),
    });
  });

  it("applies remote override when shadow mode is disabled", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "delegate",
              confidence: 0.79,
              abstain_reason: null,
              ack_text: "收到",
            }),
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.95,
              abstain_reason: null,
              ack_text: "我来直接答",
              override_recommendation: "override_local",
              adjudication_reason: "clear direct-answer request",
            }),
          },
        }],
      }));

    const decision = await resolveStatelessPolicyDecision("继续", {
      metadata: {
        _dualJudgeConfig: buildDualJudgeConfig({
          remote: { shadowMode: false },
        }),
      },
    });

    expect(routeDecisionOf(decision).route).toBe("reply");
    expect(decision._judge_route).toBe("reply");
    expect(decision._judge_ack_text).toBe("我来直接答");
    expect(decision._judge_shadow_log).toMatchObject({
      local_judge_route: "delegate",
      final_judge_route: "reply",
      remote_override_applied: true,
      remote_judge_result: expect.objectContaining({
        route: "reply",
        override_recommendation: "override_local",
      }),
    });
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
    expect(decision._judge_shadow_log).toMatchObject({
      remote_judge_enabled: false,
      remote_judge_shadow_mode: true,
      remote_judge_result: null,
      local_judge_route: "delegate",
      final_judge_route: "delegate",
    });
  });

  it("retries without response_format when provider rejects it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textErrorResponse(400, "unknown field 'response_format'"))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "delegate",
              confidence: 0.87,
              abstain_reason: null,
              ack_text: "继续处理",
              override_recommendation: "accept_local",
              adjudication_reason: "fallback succeeded",
            }),
          },
        }],
      }));

    const result = await callRemoteJudge(
      buildJudgeInput(),
      buildJudgeResult(),
      "short_turn_context_dependent",
      buildDualJudgeConfig(),
    );

    expect(result?.override_recommendation).toBe("accept_local");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstPayload.response_format).toEqual({ type: "json_object" });
    expect(secondPayload.response_format).toBeUndefined();
  });
});
