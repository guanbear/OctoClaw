
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  delegationFailureReply,
  guardAssistantMessageForPolicyState,
  sanitizeDelegationReasoning,
} from "./replay/replay-logger.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
} from "./resolve/route-helpers.js";
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
  it("tier 0 = 18s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[0]).toBe(18_000);
  });

  it("tier 1 = 45s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[1]).toBe(45_000);
  });

  it("tier 2 = 120s", () => {
    expect(DEFAULT_TIER_DELAYS_MS[2]).toBe(120_000);
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

  it("reply timers fire at 18s, 45s, 120s via createAckTimers", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "regression-reply-timers",
      sessionKey: "slack:default:channel:C_REG:thread:123",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(18_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].tier).toBe(0);

    vi.advanceTimersByTime(45_000 - 18_000);
    expect(fired).toHaveLength(2);
    expect(fired[1].tier).toBe(1);

    vi.advanceTimersByTime(120_000 - 45_000);
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
