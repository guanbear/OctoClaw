import { describe, expect, it, vi } from "vitest";
import { buildPromptContextProjection, extractInboundMessageTimestamp, guardOutboundMessageForPolicyState, resolveDelegationCapability } from "./extension-entry.js";
import { policyState } from "./state/policy-state.js";

describe("resolveDelegationCapability", () => {
  it("fails closed when delegation is requested but host detached runtime support is missing", () => {
    const resolved = resolveDelegationCapability({
      pluginConfig: { delegationEnabled: true },
      env: {},
      registerDetachedTaskRuntime: undefined,
    });

    expect(resolved).toEqual({
      requested: true,
      hostSupported: false,
      enabled: false,
      reason: "host_missing_detached_runtime",
    });
  });

  it("enables delegation when config allows it and host support is present", () => {
    const resolved = resolveDelegationCapability({
      pluginConfig: { delegationEnabled: true },
      env: {},
      registerDetachedTaskRuntime: vi.fn(),
    });

    expect(resolved).toEqual({
      requested: true,
      hostSupported: true,
      enabled: true,
      reason: "",
    });
  });

  it("stays disabled when config or env disables delegation", () => {
    const resolved = resolveDelegationCapability({
      pluginConfig: { delegationEnabled: false },
      env: { OCTOCLAW_DELEGATION_ENABLED: "false" },
      registerDetachedTaskRuntime: vi.fn(),
    });

    expect(resolved).toEqual({
      requested: false,
      hostSupported: true,
      enabled: false,
      reason: "disabled_by_config",
    });
  });
});


describe("buildPromptContextProjection", () => {
  it("keeps route policy projections out of user prependContext", () => {
    const projected = buildPromptContextProjection({
      prependSystem: ["Use status tools for status questions."],
      contextPayload: "route=delegate | worker_pool=octoclaw-research | allowed_control_tools=octoclaw_status",
      shouldInjectPolicyProjection: true,
    });

    expect(projected?.prependContext).toBeUndefined();
    expect(projected?.prependSystemContext).toContain("[OctoClaw policy projection]");
    expect(projected?.prependSystemContext).toContain("route=delegate");
  });

  it("returns undefined when there is nothing to inject", () => {
    expect(buildPromptContextProjection({
      prependSystem: [],
      contextPayload: "",
      shouldInjectPolicyProjection: false,
    })).toBeUndefined();
  });
});


describe("extractInboundMessageTimestamp", () => {
  it("finds nested Slack timestamps from provider payloads", () => {
    expect(extractInboundMessageTimestamp({ payload: { event: { message: { ts: "1777333611.122709" } } } }, {}, "")).toBe("1777333611.122709");
  });

  it("falls back to prompt metadata JSON", () => {
    expect(extractInboundMessageTimestamp({}, {}, '{"message_ts":"1777333628.133229"}')).toBe("1777333628.133229");
  });
});

describe("guardOutboundMessageForPolicyState", () => {
  it("rewrites Slack outbound direct answer when delegate route has no execution evidence", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: { route_decision: { route: "delegate" } },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", content: "刚才的子 agent 已经跑完了，以下是调研摘要。" },
      { channelId: "slack" },
      now,
    );

    expect(guarded?.content).toBe("这次任务还没派发成功，等我拿到真实执行结果后回复。");
    policyState.clearState(key);
  });

  it("does not rewrite Slack outbound when dispatch evidence exists", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: { route_decision: { route: "delegate" } },
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: false,
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", content: "刚才的子 agent 已经跑完了，以下是调研摘要。" },
      { channelId: "slack" },
      now,
    );

    expect(guarded).toBeUndefined();
    policyState.clearState(key);
  });
});
