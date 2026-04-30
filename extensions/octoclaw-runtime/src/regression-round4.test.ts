
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { compactPolicyPrompt } from "./replay/policy-utils.js";
import { guardOutboundMessageForPolicyState } from "./extension-entry.js";
import {
  delegationFailureReply,
  guardAssistantMessageForPolicyState,
  sanitizeDelegationReasoning,
} from "./replay/message-guard.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
} from "./resolve/route-helpers.js";
import { PolicyStateStore, policyState } from "./state/policy-state.js";
import {
  shouldSuppressAck,
  recordMessage,
  resetBurstState,
  type AckGateState,
} from "./ack/ack-burst.js";
import {
  shouldScheduleTier,
  DEFAULT_TIER_DELAYS_MS,
  createAckTimers,
  cancelAllAckTimers,
  type AckTimerResult,
} from "./ack/ack-timing.js";
import { latencyAckStage, shouldSendLatencyAck } from "./ack/ack-guard.js";
import { selectDispatchPolicyDecision, selectReplaySessionKeyForDispatch } from "./tools/registration.js";


describe("regression round 4: contaminated session guard is narrow", () => {
  function textOf(result: { message?: Record<string, unknown> }): string {
    return String((result.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "");
  }

  const contaminatedState = {
    sessionBoundary: { status: "contaminated_subagent_identity" },
    decision: { route_decision: { route: "reply", task_class: "main_direct" } },
  };

  it("does not replace plain chat in a contaminated registry session", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "在的，有什么我可以帮你？" }] },
      contaminatedState,
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not replace direct lookup answers that have no subagent leak", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "OpenClaw 最近一次发布说明主要更新了运行时和 Slack 集成。" }] },
      contaminatedState,
    );

    expect(guarded.mode).toBe("pass");
  });

  it("preserves status projection output in a contaminated registry session", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "OctoClaw native runtime status (anchors)\nVisible records: 0\nNo runtime task state is currently available." }] },
      {
        ...contaminatedState,
        controlToolsSeen: ["octoclaw_status"],
      },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("still replaces raw subagent context leaks", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> source: subagent session_key: agent:main:subagent:abc rawTranscript: ..." }] },
      contaminatedState,
    );

    expect(guarded.mode).toBe("replace");
    expect(textOf(guarded)).toContain("当前任务最新状态");
  });
});

describe("regression round 4: scenario 1 — sanitizer empty fallback", () => {
  it("returns fallback for empty string input", () => {
    const result = sanitizeDelegationReasoning("");
    expect(result).toBe("收到，正在处理。");
  });

  it("returns fallback for whitespace-only input after trim", () => {
    const result = sanitizeDelegationReasoning("   \n\n   ");
    expect(result).toBe("收到，正在处理。");
  });

  it("strips contamination marker but preserves non-matching text", () => {
    const input = "这条追问命中了被子任务污染，后续内容";
    const result = sanitizeDelegationReasoning(input);
    expect(result).not.toContain("被子任务污染");
  });

  it("strips policy authority marker", () => {
    const input = "OctoClaw runtime policy is authoritative for this session.";
    const result = sanitizeDelegationReasoning(input);
    expect(result).not.toContain("runtime policy is authoritative");
  });
});


describe("regression round 4: scenario 2 — sanitizer strips reasoning patterns", () => {
  it("strips 适合独立委派 delegation reasoning", () => {
    const input = "这个任务适合独立委派处理。用户需要帮助。";
    const result = sanitizeDelegationReasoning(input);
    expect(result).not.toContain("适合独立委派");
    expect(result).toContain("用户需要帮助");
  });

  it("strips contamination guard text", () => {
    const input = "这条追问命中了被子任务污染。实际答案是：重启服务。";
    const result = sanitizeDelegationReasoning(input);
    expect(result).not.toContain("被子任务污染");
    expect(result).toContain("重启服务");
  });

  it("strips task boundary clarity reasoning", () => {
    const input = "任务边界非常清楚，可以独立执行。实际结果是成功。";
    const result = sanitizeDelegationReasoning(input);
    expect(result).not.toContain("任务边界");
    expect(result).toContain("实际结果是成功");
  });

  it("preserves normal user-facing text", () => {
    const input = "你好，我来帮你检查一下服务状态。";
    const result = sanitizeDelegationReasoning(input);
    expect(result).toBe(input);
  });

  it("collapses multiple newlines to double newline", () => {
    const input = "第一行\n\n\n\n\n第二行";
    const result = sanitizeDelegationReasoning(input);
    expect(result).toBe("第一行\n\n第二行");
  });
});

describe("regression round 4: scenario 2b — delegated state normalization", () => {
  it("canonicalizes mixed delegate state to delegate route", () => {
    const canonical = canonicalizeDecisionForPolicyState({
      route: "delegate",
      request_kind: "delegated_task",
      must_delegate_via: "octoclaw_dispatch",
      route_decision: {
        route: "reply",
        system_preferred_route: "reply",
        dispatch_required: false,
        task_class: "main_direct",
      },
      tool_policy: {},
      router_decision_v2: {},
    });

    expect(authoritativeDecisionRoute(canonical, "reply")).toBe("delegate");
    expect((canonical.route_decision as { route: string }).route).toBe("delegate");
    expect((canonical.route_decision as { dispatch_required: boolean }).dispatch_required).toBe(true);
    expect((canonical.tool_policy as { must_delegate_via: string }).must_delegate_via).toBe("octoclaw_dispatch");
    expect((canonical.router_decision_v2 as { request_kind: string }).request_kind).toBe("delegated_task");
  });

  it("allows truthful no-subagent provenance wording without dispatch evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "不是子 agent 查的，是主会话直接用了 exec 和 web_fetch 查到的；没有派发 delegated task。",
        }],
      },
      {
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        directToolsSeen: ["exec", "web_fetch"],
        decision: { route_decision: { route: "reply", task_class: "main_direct" } },
      },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("replaces false sessions_spawn dispatch claim without execution evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "好的，我来委派子 agent 做这个调研。\n路由已切换到 delegate，开始派发。\nWorkContract 仍然阻止 dispatch。让我直接用 sessions_spawn 派发子 agent。\n已派发子 agent（`status-panel-research`），正在调研。",
        }],
      },
      {
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        decision: { route_decision: { route: "reply", task_class: "main_direct" } },
      },
    );

    expect(guarded.mode).toBe("replace");
    const text = (guarded.message as { content: Array<{ text: string }> }).content[0]?.text || "";
    expect(text).toContain("还没派发成功");
    expect(text).not.toContain("sessions_spawn");
    expect(text).not.toContain("已派发子 agent");
  });

  it("allows status surface projection after octoclaw_status even when delegate spawn is absent", () => {
    const guarded = guardAssistantMessageForPolicyState(
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "OctoClaw native runtime status (compact)\nFields: task_id | projected_status(raw_status) | route | elapsed | model | backend | reason\n- task-1 | queued(queued) | delegate | elapsed=26s | model=unknown | backend=octoclaw-research | reason=dispatch_materialized_but_no_spawn_evidence",
        }],
      },
      {
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        controlToolsSeen: ["octoclaw_status"],
        decision: {
          route: "delegate",
          route_decision: { route: "delegate", task_class: "control_observer" },
        },
      },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("strips stale delegate failure projection from reply-route answers", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "这次任务还没派发成功，等我拿到真实执行结果后回复。\n本机 OpenClaw：2026.4.21。" }] },
      {
        decision: {
          work_contract: { route: "reply" },
          route_decision: { route: "reply", task_class: "main_direct" },
        },
        latestExecutionReceipt: {
          route: "reply",
          dispatchExecuted: false,
          spawnExecuted: false,
        },
        dispatchExecuted: false,
        spawnExecuted: false,
      },
    );

    const text = (guarded.message as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text
      || ((guarded.message as { content?: string } | undefined)?.content ?? "");
    expect(guarded.mode).toBe("replace");
    expect(text).toBe("本机 OpenClaw：2026.4.21。");
  });

  it("does not project delegate failure over a plain greeting reply", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "你好，我在。" }] },
      {
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        decision: {
          route: "delegate",
          route_correction: {
            from: "delegate",
            to: "reply",
            source: "validator",
            reason: "plain_chat_pre_dispatch",
          },
          router_decision_v2: { request_kind: "delegated_task" },
          route_decision: { route: "delegate", task_class: "main_direct" },
        },
      },
    );

    const text = (guarded.message as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text
      || ((guarded.message as { content?: string } | undefined)?.content ?? "");
    expect(text).not.toContain("还没派发成功");
    expect(text).not.toContain("真实执行结果");
  });

  it("replaces leaked direct reply when delegated task was not dispatched", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "我来写。收到，我看一下。可以，给你一个通用版：" }] },
      {
        delegated: false,
        decision: {
          route: "delegate",
          request_kind: "delegated_task",
          must_delegate_via: "octoclaw_dispatch",
          route_decision: {
            route: "reply",
            system_preferred_route: "reply",
            dispatch_required: false,
            task_class: "main_direct",
          },
        },
      },
    );

    expect(guarded.mode).toBe("replace");
    const text = (guarded.message as { content: Array<{ text: string }> }).content[0]?.text || "";
    expect(text).toContain("还没派发成功");
    expect(text).not.toContain("通用版");
    expect(text).toBe(
      (delegationFailureReply({
        delegated: false,
        decision: {
          route: "delegate",
          route_decision: { route: "reply" },
          must_delegate_via: "octoclaw_dispatch",
        },
      }).message as { content: Array<{ text: string }> }).content[0]?.text || "",
    );
  });

  it("does not mark delegated=true before dispatch actually happens", () => {
    const store = new PolicyStateStore({
      sessionStateFile: "/tmp/octoclaw-policy-state-regression-round4.json",
      ttlMs: 60_000,
      persistDebounceMs: 60_000,
    });
    store.set("state-key", {
      prompt: "查下 openclaw 4.22 的新特性",
      delegated: false,
      decision: {
        route: "delegate",
        request_kind: "delegated_task",
        must_delegate_via: "octoclaw_dispatch",
        route_decision: {
          route: "delegate",
          system_preferred_route: "delegate",
          dispatch_required: true,
        },
      },
    });

    expect(store.get("state-key")?.delegated).toBe(false);
  });

  it("prefers explicit policyJson over stale state decision during dispatch", () => {
    const selected = selectDispatchPolicyDecision(
      {
        route: "reply",
        route_decision: {
          route: "reply",
          system_preferred_route: "reply",
        },
      },
      JSON.stringify({
        route: "delegate",
        route_decision: {
          route: "delegate",
          system_preferred_route: "delegate",
          dispatch_required: true,
        },
        tool_policy: {
          must_delegate_via: "octoclaw_dispatch",
        },
      }),
    );

    expect(selected).toMatchObject({
      route_decision: {
        route: "delegate",
        system_preferred_route: "delegate",
        dispatch_required: true,
      },
      tool_policy: {
        must_delegate_via: "octoclaw_dispatch",
      },
    });
  });

  it("prefers the real user session over policy cache key for dispatch replay binding", () => {
    const replaySessionKey = selectReplaySessionKeyForDispatch(
      {
        sessionKey: "agent:main:slack:default:direct:u0al9t5u89z",
        sessionId: "main-session-id",
        agentId: "main",
      },
      {
        session_key: "agent:main:slack:default:direct:u0al9t5u89z",
        session_origin: "slack",
        session_binding_key: "slack:user:u0al9t5u89z",
      },
      "policy-2084244bc8270d8a",
      {
        canonicalSessionKey: "agent:main:slack:default:direct:u0al9t5u89z",
      },
      {
        request: {
          session_key: "agent:main:slack:default:direct:u0al9t5u89z",
        },
      },
      {},
    );

    expect(replaySessionKey).toBe("agent:main:slack:default:direct:u0al9t5u89z");
  });

  it("recovers the real user session from cached state request metadata during dispatch", () => {
    const replaySessionKey = selectReplaySessionKeyForDispatch(
      {
        sessionKey: "",
        sessionId: "",
        agentId: "main",
      },
      {
        session_key: "policy-2084244bc8270d8a",
      },
      "policy-2084244bc8270d8a",
      {
        decision: {
          request: {
            session_key: "agent:main:slack:default:direct:u0al9t5u89z",
            metadata: {
              session_key: "agent:main:slack:default:direct:u0al9t5u89z",
            },
          },
        },
      },
      {},
      {},
    );

    expect(replaySessionKey).toBe("agent:main:slack:default:direct:u0al9t5u89z");
  });

  it("dispatch policy context can fall back to recent delegated state for follow-up prompts", () => {
    const store = new PolicyStateStore({
      sessionStateFile: "/tmp/octoclaw-policy-state-regression-round4-followup.json",
      ttlMs: 60_000,
      persistDebounceMs: 60_000,
    });
    store.set("agent:main:slack:default:direct:u0al9t5u89z", {
      prompt: "查下 openclaw 4.22 的新特性",
      decision: {
        request: {
          session_key: "agent:main:slack:default:direct:u0al9t5u89z",
          metadata: {
            session_key: "agent:main:slack:default:direct:u0al9t5u89z",
          },
        },
        route_decision: {
          route: "delegate",
          system_preferred_route: "delegate",
          dispatch_required: true,
        },
      },
      delegated: true,
    });

    const resolved = store.getDispatchPolicyContext({}, `用户追问先前委派任务\u201C查下 openclaw 4.22 的新特性\u201D的当前进展，并需要基于当前回合的权威执行事实回复状态。`);
    expect(resolved.key).toBe("agent:main:slack:default:direct:u0al9t5u89z");
    expect((resolved.state?.decision as { request?: { session_key?: string } })?.request?.session_key).toBe(
      "agent:main:slack:default:direct:u0al9t5u89z",
    );
  });

  it("does not replace a direct reply that was explicitly executed after delegate intent", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "收到，正在查。" }] },
      {
        delegated: false,
        dispatchRoute: "reply",
        dispatchExecuted: true,
        decision: {
          route: "delegate",
          route_decision: {
            route: "delegate",
            system_preferred_route: "delegate",
            dispatch_required: true,
          },
          tool_policy: {
            must_delegate_via: "octoclaw_dispatch",
          },
        },
      },
    );

    expect(guarded.mode).toBe("pass");
  });
});


describe("regression round 4: scenario 3 — ACK gate eligible: tool_active/blocked only", () => {
  const threadKey = "slack:channel:C999:thread_T001";

  beforeEach(() => {
    resetBurstState();
  });

  it("allows ACK when tool_active is true (after silence window)", () => {
    recordMessage(threadKey, Date.now() - 10_000);
    const gate: AckGateState = { tool_active: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(false);
    expect(result.reason).toBe("allow");
  });

  it("allows ACK when blocked is true (after silence window)", () => {
    recordMessage(threadKey, Date.now() - 10_000);
    const gate: AckGateState = { blocked: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(false);
    expect(result.reason).toBe("allow");
  });

  it("allows ACK when both tool_active and blocked are true", () => {
    recordMessage(threadKey, Date.now() - 10_000);
    const gate: AckGateState = { tool_active: true, blocked: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(false);
  });

  it("suppresses when delegated_running is true but tool_active/blocked are false", () => {
    recordMessage(threadKey, Date.now() - 10_000);
    const gate: AckGateState = { delegated_running: true, tool_active: false, blocked: false };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("not_ack_eligible_no_active_work");
  });

  it("suppresses when all gate flags are false", () => {
    recordMessage(threadKey, Date.now() - 10_000);
    const gate: AckGateState = { tool_active: false, blocked: false, delegated_running: false };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("not_ack_eligible_no_active_work");
  });
});

describe("regression round 4: scenario 3b — latency ack routing", () => {
  it("allows latency ack for delegated work when required", () => {
    expect(shouldSendLatencyAck(
      {
        route_decision: {
          route: "delegate",
        },
        latency_ack: {
          required: true,
        },
      },
      {},
      { trigger: "user" },
      "direct_lookup",
    )).toBe(true);
  });

  it("uses delegate_started copy for delegated latency ack", () => {
    expect(latencyAckStage({
      route_decision: {
        route: "delegate",
      },
    })).toBe("delegate_started");
  });
});


describe("regression round 4: scenario 4 — ACK suppress states", () => {
  const threadKey = "slack:channel:C998:thread_T002";

  beforeEach(() => {
    resetBurstState();
  });

  it("suppresses when delivered is true (even with tool_active)", () => {
    const gate: AckGateState = { delivered: true, tool_active: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("delivered");
  });

  it("suppresses when final_response_streaming is true", () => {
    const gate: AckGateState = { final_response_streaming: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("final_response_streaming");
  });

  it("suppresses when delivery_pending is true", () => {
    const gate: AckGateState = { delivery_pending: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("delivery_pending");
  });

  it("suppresses when formal_reply_visible is true", () => {
    const gate: AckGateState = { formal_reply_visible: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("formal_reply_visible");
  });

  it("final_response_streaming suppresses even with delegated_running", () => {
    const gate: AckGateState = { final_response_streaming: true, delegated_running: true };
    const result = shouldSuppressAck(threadKey, "tool_still_working", "delegate", {}, gate);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("final_response_streaming");
  });
});


describe("regression round 4: scenario 5 — timer tier delays", () => {
  it("tier 0 = 12s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[0]).toBe(12_000);
  });

  it("tier 1 = 30s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[1]).toBe(30_000);
  });

  it("tier 2 = 90s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[2]).toBe(90_000);
  });

  it("tier 3 is unused (0)", () => {
    expect(DEFAULT_TIER_DELAYS_MS[3]).toBe(0);
  });
});


describe("regression round 4: scenario 6 — ACK schedule reply-only", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelAllAckTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reply route gets 3 tiers (0,1,2)", () => {
    expect(shouldScheduleTier("reply", 0)).toBe(true);
    expect(shouldScheduleTier("reply", 1)).toBe(true);
    expect(shouldScheduleTier("reply", 2)).toBe(true);
    expect(shouldScheduleTier("reply", 3)).toBe(false);
  });

  it("delegate route gets no tiers", () => {
    expect(shouldScheduleTier("delegate", 0)).toBe(false);
    expect(shouldScheduleTier("delegate", 1)).toBe(false);
    expect(shouldScheduleTier("delegate", 2)).toBe(false);
  });

  it("observe route gets no tiers", () => {
    expect(shouldScheduleTier("observe", 0)).toBe(false);
    expect(shouldScheduleTier("observe", 1)).toBe(false);
  });

  it("pre_route route gets no tiers", () => {
    expect(shouldScheduleTier("pre_route", 0)).toBe(false);
  });

  it("reply timers fire at 12s, 30s, 90s via createAckTimers", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "regression-reply-timers",
      sessionKey: "slack:default:channel:C_REG:thread:123",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(12_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].tier).toBe(0);

    vi.advanceTimersByTime(30_000 - 12_000);
    expect(fired).toHaveLength(2);
    expect(fired[1].tier).toBe(1);

    vi.advanceTimersByTime(90_000 - 30_000);
    expect(fired).toHaveLength(3);
    expect(fired[2].tier).toBe(2);
  });

  it("delegate route gets no timer callbacks", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "regression-delegate-timers",
      sessionKey: "slack:default:channel:C_REG2:thread:456",
      routePhase: "delegate",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(200_000);
    expect(fired).toHaveLength(0);
  });
});


describe("regression round 4: execution coverage projections", () => {
  it("adds WorkContract and ExecutionCoverage evidence to provenance follow-up replies", () => {
    const content = "刚才那个任务判定为 reply，没有重新派发。";
    const state = {
      decision: {
        route_decision: { route: "reply", route_source: "execution_coverage" },
        router_decision_v2: { request_kind: "status_or_provenance" },
        model_policy: { selected_model: "zhipu/GLM-5.1" },
        workContractId: "wc-provenance-1",
        work_contract: {
          workContractId: "wc-provenance-1",
          route: "reply",
          decisionSource: "execution_coverage",
          replyMode: "answer",
        },
        _execution_coverage_packet: {
          packetId: "coverage-1",
          replyMode: "answer",
          dispatchExecuted: true,
          spawnExecuted: false,
          coverage: { execution: { coverage: "thread" } },
        },
      },
      inboundMessageTs: "1777389000.000001",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content },
      state,
    );
    expect(guarded.mode).toBe("pass");

    const previousDebug = process.env.OCTOCLAW_FOOTER_DEBUG;
    process.env.OCTOCLAW_FOOTER_DEBUG = "1";
    const key = "agent:main:slack:channel:c0provenance";
    policyState.setState(key, state);
    try {
      const outbound = guardOutboundMessageForPolicyState(
        { to: "C0PROVENANCE", content, metadata: { channelId: "C0PROVENANCE", threadTs: "1777389000.000001" } },
        { channelId: "slack", inboundMessageTs: "1777389000.000001" },
        Date.now(),
      );

      expect(outbound?.content).toContain("route=reply | model=zhipu/GLM-5.1 · thread");
      expect(outbound?.content).toContain("via=coverage");
      expect(outbound?.content).toContain("wc=wc-prov");
    } finally {
      policyState.clearState(key);
      if (previousDebug === undefined) delete process.env.OCTOCLAW_FOOTER_DEBUG;
      else process.env.OCTOCLAW_FOOTER_DEBUG = previousDebug;
    }
  });


  it("does not duplicate footer when compact coverage projection already present", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: "收到。\nroute=reply | model=direct_main | wc=wc-compact | coverage=thread | route_source=policy_rule" },
      {
        decision: {
          route_decision: { route: "reply", route_source: "policy_rule" },
          router_decision_v2: { request_kind: "status_or_provenance" },
          work_contract: { workContractId: "wc-compact", route: "reply", decisionSource: "execution_coverage" },
          model_policy: { selected_model: "direct_main" },
          _execution_coverage_packet: { replyMode: "answer", coverage: { execution: { coverage: "thread" } } },
        },
      },
    );

    expect(guarded.mode).toBe("pass");
    expect(String(guarded.message?.content)).toContain("route=reply | model=direct_main");
    expect(String(guarded.message?.content)).toContain("wc=wc-compact");
  });

  it("keeps WorkContract and coverage facts in policy prompt projections", () => {
    const text = compactPolicyPrompt({
      route_decision: { route: "reply", route_source: "rule" },
      router_decision_v2: { request_kind: "status_or_provenance" },
      workContractId: "wc-prompt-1",
      work_contract: {
        workContractId: "wc-prompt-1",
        route: "reply",
        decisionSource: "execution_coverage",
        replyMode: "answer",
      },
      _execution_coverage_packet: {
        packetId: "coverage-prompt-1",
        replyMode: "answer",
        dispatchExecuted: true,
        spawnExecuted: false,
        coverage: { execution: { coverage: "recent_turn" } },
      },
    });

    expect(text).toContain("WorkContract=wc-prompt-1");
    expect(text).toContain("ExecutionCoverage=coverage-prompt-1");
    expect(text).toContain("coverage=recent_turn");
    expect(text).toContain("dispatch_executed=true");
    expect(text).toContain("spawn_executed=false");
  });
});
