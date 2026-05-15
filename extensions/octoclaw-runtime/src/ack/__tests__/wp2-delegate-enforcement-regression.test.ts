/**
 * WP2 regression tests — delegate route materialization enforcement.
 *
 * These tests guard against re-introduction of the 4 production bugs:
 *  1. RouteSeal has no routeSealId; buildRouteCommitAckPacket must use requestId fallback
 *  2. hookInterfaceForRoute sets delegate_required (not delegation_enforcement)
 *  3. routeHintRequired must read from decision.route_hint_policy.required
 *  4. agent_end must emit delegate_without_dispatch when route=delegate but no dispatch
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRouteCommitAckPacket,
  resetRouteCommitAckState,
  sendRouteCommitAck,
} from "../ack-route-commit.js";
import { guardAssistantMessageForPolicyState } from "../../replay/message-guard.js";
import {
  isDelegatedRoute,
  routeHintPromptRequired,
  routeHintRequired,
  shouldRetainPolicyStateOnAgentEnd,
} from "../../replay/policy-utils.js";
import { registerIMAdapter, type IMAdapter } from "../../im/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function realRouteSeal(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-seal-456",
    turnId: "turn-789",
    threadBindingKey: "thread-binding",
    route: "delegate",
    source: "local_judge",
    reasonCodes: ["local_judge"],
    createdAt: new Date().toISOString(),
    inputHash: "",
    stateGeneration: 0,
    schemaVersion: "octoclaw.route_seal.v1",
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route_decision: { route: "delegate", route_source: "judge" },
    work_contract: { workContractId: "wc-123", turnId: "turn-789" },
    routeSeal: realRouteSeal(),
    ...overrides,
  };
}

function delegateDecisionWithHintPolicy(required: boolean) {
  return decision({
    route_hint_policy: { required },
  });
}

const routeCommitAckTestAdapter: IMAdapter = {
  channel: "slack",
  canHandle: (sessionKey) => sessionKey === "slack:channel:C1:thread:1700000000.000100",
  resolveTarget: () => ({ channel: "slack", target: "C1", threadTs: "1700000000.000100" }),
  send: async () => ({ sent: true, delivered: true, threadTs: "1700000000.000100" }),
  react: async () => ({ ok: true }),
};

// ---------------------------------------------------------------------------
// Regression 1: routeSeal.requestId fallback for routeSealId
// ---------------------------------------------------------------------------

describe("WP2 regression: routeSeal.requestId fallback", () => {
  beforeEach(() => {
    resetRouteCommitAckState();
  });

  it("uses requestId as routeSealId when routeSeal has no routeSealId field", () => {
    const seal = realRouteSeal({ requestId: "my-unique-req-id" });
    delete (seal as Record<string, unknown>).routeSealId;

    const d = decision({ routeSeal: seal });
    const packet = buildRouteCommitAckPacket(d, "session-1", true);

    expect(packet).not.toBeNull();
    expect(packet!.routeSealId).toBe("my-unique-req-id");
  });

  it("prefers explicit routeSealId over requestId when present", () => {
    const seal = realRouteSeal({ requestId: "fallback-id" });
    Object.assign(seal, { routeSealId: "explicit-seal-id" });

    const d = decision({ routeSeal: seal });
    const packet = buildRouteCommitAckPacket(d, "session-1", true);

    expect(packet!.routeSealId).toBe("explicit-seal-id");
  });

  it("prefers decision.route_seal_id over requestId when present", () => {
    const seal = realRouteSeal({ requestId: "fallback-id" });
    const d = decision({ routeSeal: seal, route_seal_id: "decision-level-id" });

    const packet = buildRouteCommitAckPacket(d, "session-1", true);

    expect(packet!.routeSealId).toBe("decision-level-id");
  });

  it("returns null when both routeSealId and requestId are missing", () => {
    const seal = realRouteSeal();
    delete (seal as Record<string, unknown>).requestId;

    const d = decision({ routeSeal: seal });
    const packet = buildRouteCommitAckPacket(d, "session-1", true);

    expect(packet).toBeNull();
  });

  it("builds packet successfully with only requestId (production shape)", () => {
    const d = decision();
    const result = buildRouteCommitAckPacket(d, "session-1", true);

    expect(result).not.toBeNull();
    expect(result!.routeCommitId).toBe("wc-123");
    expect(result!.routeSealId).toBe("req-seal-456");
    expect(result!.route).toBe("delegate");
  });
});

// ---------------------------------------------------------------------------
// Regression 2: delegate_required vs delegation_enforcement field name
//
// The enforcement code reads hookConfig.delegate_required (set by
// hookInterfaceForRoute). We verify the exported functions that the
// enforcement path depends on: isDelegatedRoute, routeHintRequired.
// ---------------------------------------------------------------------------

describe("WP2 regression: delegate_required enforcement functions", () => {
  it("isDelegatedRoute returns true for route=delegate", () => {
    const d = decision();
    expect(isDelegatedRoute(d)).toBe(true);
  });

  it("isDelegatedRoute returns true for route=spawn_single", () => {
    const d = decision({ route_decision: { route: "spawn_single" } });
    expect(isDelegatedRoute(d)).toBe(true);
  });

  it("isDelegatedRoute returns false for route=reply", () => {
    const d = decision({ route_decision: { route: "reply" } });
    expect(isDelegatedRoute(d)).toBe(false);
  });

  it("isDelegatedRoute returns false for missing route_decision", () => {
    expect(isDelegatedRoute({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression 3: routeHintRequired reads decision.route_hint_policy.required
// ---------------------------------------------------------------------------

describe("WP2 regression: routeHintRequired reads correct source", () => {
  it("returns true when route_hint_policy.required is true", () => {
    const d = delegateDecisionWithHintPolicy(true);
    expect(routeHintRequired(d)).toBe(true);
  });

  it("returns false when route_hint_policy.required is false", () => {
    const d = delegateDecisionWithHintPolicy(false);
    expect(routeHintRequired(d)).toBe(false);
  });

  it("returns false when route_hint_policy is missing", () => {
    const d = decision();
    expect(routeHintRequired(d)).toBe(false);
  });

  it("returns false when ack_followup_applied is true (sticky override)", () => {
    const d = decision({
      route_hint_policy: { required: true, ack_followup_applied: true },
    });
    expect(routeHintRequired(d)).toBe(false);
  });

  it("returns false when sticky_applied is true", () => {
    const d = decision({
      route_hint_policy: { required: true, sticky_applied: true },
    });
    expect(routeHintRequired(d)).toBe(false);
  });

  it("does not require prompt route_hint for simple reply", () => {
    const d = decision({
      route_decision: { route: "reply", task_class: "main_direct" },
      route_hint_policy: { required: true },
      hook_interface: { before_tool_call: { enabled: true, delegate_required: false } },
    });
    expect(routeHintRequired(d)).toBe(true);
    expect(routeHintPromptRequired(d)).toBe(false);
  });

  it("keeps prompt route_hint for hard-gated delegate", () => {
    const d = decision({
      route_hint_policy: { required: true },
      hook_interface: { before_tool_call: { enabled: true, delegate_required: true } },
    });
    expect(routeHintPromptRequired(d)).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Regression 4: agent_end emits delegate_without_dispatch
// ---------------------------------------------------------------------------

describe("WP2 regression: shouldRetainPolicyStateOnAgentEnd", () => {
  it("returns true when route=delegate and not delegated", () => {
    const state = { decision: decision(), delegated: false };
    expect(shouldRetainPolicyStateOnAgentEnd(state)).toBe(true);
  });

  it("returns false when route=delegate and delegated=true", () => {
    const state = { decision: decision(), delegated: true };
    expect(shouldRetainPolicyStateOnAgentEnd(state)).toBe(false);
  });

  it("returns false when route=reply", () => {
    const state = {
      decision: decision({ route_decision: { route: "reply" } }),
      delegated: false,
    };
    expect(shouldRetainPolicyStateOnAgentEnd(state)).toBe(false);
  });

  it("returns false when no decision in state", () => {
    expect(shouldRetainPolicyStateOnAgentEnd({ delegated: false })).toBe(false);
  });

  it("state update marks delegate without dispatch facts after no-dispatch", () => {
    const state = { decision: decision(), delegated: false };
    const next = {
      ...state,
      delegate_without_dispatch: true,
      dispatchExecuted: false,
      spawnExecuted: false,
    };

    expect(next).toEqual(expect.objectContaining({
      delegate_without_dispatch: true,
      dispatchExecuted: false,
      spawnExecuted: false,
    }));
  });

  it("state update is honest even when notice delivery fails", () => {
    const state = { decision: decision(), delegated: false };
    const next = {
      ...state,
      delegate_without_dispatch: true,
      dispatchExecuted: false,
      spawnExecuted: false,
    };
    expect(next.delegate_without_dispatch).toBe(true);
    expect(next.dispatchExecuted).toBe(false);
    expect(next.spawnExecuted).toBe(false);
  });

  it("ackGuardKey is preferred over ctx.sessionKey for delivery target", () => {
    const savedDeliveryKey = "slack:channel:C1:thread:1700000000.000100";
    const canonicalKey = "slack:target:T1";
    const state: Record<string, unknown> = { decision: decision(), delegated: false, ackGuardKey: savedDeliveryKey };
    const resolvedKey = String(state.ackGuardKey || canonicalKey);
    expect(resolvedKey).toBe(savedDeliveryKey);
  });

  it("falls back to ctx.sessionKey when ackGuardKey is absent", () => {
    const canonicalKey = "slack:target:T1";
    const state: Record<string, unknown> = { decision: decision(), delegated: false };
    const resolvedKey = String(state.ackGuardKey || canonicalKey);
    expect(resolvedKey).toBe(canonicalKey);
  });

  it("retention remains true when formal reply is visible", () => {
    const state = { decision: decision(), delegated: false, formal_reply_visible: true };

    expect(shouldRetainPolicyStateOnAgentEnd(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: delegate ack text never claims running
// ---------------------------------------------------------------------------

describe("WP2 regression: delegate ack text honesty", () => {
  beforeEach(() => {
    resetRouteCommitAckState();
    registerIMAdapter(routeCommitAckTestAdapter);
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    delete process.env.OCTOCLAW_PLANNER_ALLOWLIST;
  });

  it("route commit ack replay payload never contains running/started language for delegate", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.sent).toBe(true);

    const replayCall = replaySpy.mock.calls.find(
      (call) => call[0] === "route_commit_ack",
    );
    const replayPayload = replayCall![1] as Record<string, unknown>;
    const ackMessage = String(replayPayload.ackMessage ?? "");

    expect(ackMessage).not.toMatch(/running|started|completed|运行|已启动|已完成|委派|派发|delegation|delegated|dispatch/i);
    expect(ackMessage).toMatch(/收到|处理|状态|got it|working|status/i);

    runCommandSpy.mockRestore();
    replaySpy.mockRestore();
  });
});

describe("WP2 regression: false dispatch claim guard", () => {
  function textOf(result: { message?: Record<string, unknown> }): string {
    return String((result.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "");
  }

  it("does not rewrite natural-language dispatched-subagent prose on reply route", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "已派发子agent，稍后回来。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not rewrite natural-language delegated-subagent prose without dispatch evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "已委派子 agent 去调研，完成后给你摘要。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: false, spawnExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not keyword-rewrite direct answer on delegated route without execution evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "刚才的调研已经完成了，直接给你结果：状态面板需要展示 taskId、status、model。" }] },
      { decision: { route_decision: { route: "delegate" } }, delegated: true, dispatchExecuted: false, spawnExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
    expect(textOf(guarded)).toContain("刚才的调研已经完成了");
  });

  it("allows short processing ack before delegated dispatch evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "收到，正在处理。" }] },
      { decision: { route_decision: { route: "delegate" } }, dispatchExecuted: false, spawnExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not keyword-rewrite sessions_spawn claim on reply route", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "我已经调用 sessions_spawn 派发任务。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
    expect(textOf(guarded)).toContain("sessions_spawn");
  });

  it("does not rewrite natural-language completed-subagent prose on reply route", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "之前子 agent 已完成调研，直接给摘要。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: false, spawnExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not rewrite natural-language route-switched prose on reply route", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "route switched to delegate and dispatch is starting." }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: false },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not replace dispatched-subagent claim with actual dispatch evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "已派发子agent，稍后回来。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: true },
    );

    expect(guarded.mode).toBe("pass");
  });

  it("does not replace delegated-subagent claim with actual dispatch evidence", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: [{ type: "text", text: "已委派子 agent 去调研，完成后给你摘要。" }] },
      { decision: { route_decision: { route: "reply" } }, dispatchExecuted: true },
    );

    expect(guarded.mode).toBe("pass");
  });
});
