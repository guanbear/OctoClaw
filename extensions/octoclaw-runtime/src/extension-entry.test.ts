import { describe, expect, it, vi } from "vitest";
import { buildPromptContextProjection, extractInboundMessageTimestamp, guardOutboundMessageForPolicyState, plugin, resolveDelegationCapability } from "./extension-entry.js";
import { policyState } from "./state/policy-state.js";
import { getToolRegistrations } from "./tools/registration.js";

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
      decision: { route_decision: { route: "delegate" }, request: { metadata: { message_id: "1777368519.770689" } } },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      inboundMessageTs: "1777368519.770689",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", replyToMessageId: "1777368519.770689", content: "刚才的子 agent 已经跑完了，以下是调研摘要。" },
      { channelId: "slack", inboundMessageTs: "1777368519.770689" },
      now,
    );

    expect(guarded?.content).toContain("这次任务还没派发成功");
    expect(guarded?.content).toContain("OctoClaw 投影：委派(delegate)");
    policyState.clearState(key);
  });

  it("does not rewrite Slack outbound when dispatch evidence exists", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: { route_decision: { route: "delegate" }, request: { metadata: { message_id: "1777368520.770689" } } },
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: false,
      inboundMessageTs: "1777368520.770689",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", replyToMessageId: "1777368520.770689", content: "刚才的子 agent 已经跑完了，以下是调研摘要。" },
      { channelId: "slack", inboundMessageTs: "1777368520.770689" },
      now,
    );

    expect(guarded?.content).toContain("刚才的子 agent 已经跑完了");
    expect(guarded?.content).toContain("OctoClaw 投影：委派(delegate)");
    policyState.clearState(key);
  });

  it("can disable outbound projection footer with env switch", () => {
    const previous = process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = "0";
    const now = Date.now();
    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: { route_decision: { route: "reply" }, model_policy: { selected_model: "model-a" }, request: { metadata: { message_id: "1777368522.770689" } } },
      inboundMessageTs: "1777368522.770689",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", replyToMessageId: "1777368522.770689", content: "好的。" },
      { channelId: "slack", inboundMessageTs: "1777368522.770689" },
      now,
    );

    expect(guarded).toBeUndefined();
    policyState.clearState(key);
    if (previous === undefined) delete process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    else process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = previous;
  });



  it("does not rewrite a reply when only stale same-target delegate state exists", () => {
    const now = Date.now();
    const staleKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const currentKey = "agent:main:slack:default:direct:u0al9t5u89z:thread:1777368519.770689";
    policyState.setState(staleKey, {
      decision: { route_decision: { route: "delegate" }, request: { metadata: { message_id: "1777367569.124329" } } },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      inboundMessageTs: "1777367569.124329",
      createdAt: now - 30_000,
      updatedAt: now - 30_000,
    });
    policyState.setState(currentKey, {
      decision: {
        work_contract: { route: "reply", workContractId: "wc-current" },
        route_decision: { route: "reply", task_class: "main_direct" },
        request: { metadata: { message_id: "1777368519.770689" } },
      },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      inboundMessageTs: "1777368519.770689",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "U0AL9T5U89Z", replyToMessageId: "1777368519.770689", content: "最新版是 OpenClaw 2026.4.25。" },
      { channelId: "slack", inboundMessageTs: "1777368519.770689" },
      now,
    );

    expect(guarded?.content).toContain("最新版是 OpenClaw");
    expect(guarded?.content).toContain("OctoClaw 投影：reply");
    policyState.clearState(staleKey);
    policyState.clearState(currentKey);
  });

  it("does not rewrite outbound messages without a current message anchor", () => {
    const now = Date.now();
    const key = "agent:main:slack:default:direct:u0al9t5u89z";
    policyState.setState(key, {
      decision: { route_decision: { route: "delegate" } },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "U0AL9T5U89Z", content: "最新版是 OpenClaw 2026.4.25。" },
      { channelId: "slack" },
      now,
    );

    expect(guarded).toBeUndefined();
    policyState.clearState(key);
  });


  it("appends a conservative footer for visible Slack delivery when state is missing", () => {
    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", content: "收到。", metadata: { channelId: "C0AS4DAPPU3", threadTs: "1777387367.594319" } },
      { channelId: "slack", model: "GLM-5.1" },
      Date.now(),
    );

    expect(guarded?.content).toContain("收到。");
    expect(guarded?.content).toContain("OctoClaw 投影：reply；模型：GLM-5.1");
  });

  it("appends footer for visible Slack delivery hooks even when OpenClaw omits message anchors", () => {
    const now = Date.now();
    const key = "agent:main:slack:default:direct:u0al9t5u89z";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "reply" },
        model_policy: { selected_model: "GLM-5.1" },
      },
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "U0AL9T5U89Z", content: "这是最终回复。", metadata: { channel: "slack" } },
      { channelId: "slack" },
      now,
    );

    expect(guarded?.content).toContain("这是最终回复。");
    expect(guarded?.content).toContain("OctoClaw 投影：reply；模型：GLM-5.1");
    policyState.clearState(key);
  });

  it("does not rewrite Slack outbound natural-language subagent prose on reply route", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: { route_decision: { route: "reply" }, request: { metadata: { message_id: "1777368521.770689" } } },
      delegated: false,
      dispatchExecuted: false,
      spawnExecuted: false,
      inboundMessageTs: "1777368521.770689",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", replyToMessageId: "1777368521.770689", content: "好的，policy 判定为 reply。之前子 agent 已完成调研，直接给摘要。" },
      { channelId: "slack", inboundMessageTs: "1777368521.770689" },
      now,
    );

    expect(guarded?.content).toContain("policy 判定为 reply");
    expect(guarded?.content).toContain("OctoClaw 投影：reply");
    policyState.clearState(key);
  });
});


describe("octoclaw_route_hint policy state aliases", () => {
  it("stores the merged route on every current context alias", async () => {
    const key = "agent:main:slack:default:direct:u0al9t5u89z";
    const alias = "session-alias-route-hint";
    policyState.clearState(key);
    policyState.clearState(alias);

    const routeHint = getToolRegistrations().find((tool) => tool.name === "octoclaw_route_hint");
    expect(routeHint).toBeTruthy();
    const result = await routeHint!.execute({
      task: "hello",
      routeHint: "reply",
      confidence: 0.9,
      reason: "direct answer",
    }, { sessionKey: key, sessionId: alias, agentId: "main" });

    expect(JSON.stringify(result)).toContain("final route is reply");
    expect(policyState.getState(key)?.routeHintSubmitted).toBe(true);
    expect(policyState.getState(alias)?.routeHintSubmitted).toBe(true);

    policyState.clearState(key);
    policyState.clearState(alias);
  });
});


describe("before_tool_call route hint guard", () => {


  it("does not block octoclaw_dispatch with the manual delegation pattern guard", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: {
          must_delegate_via: "octoclaw_dispatch",
          allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
          block_tool_patterns: ["sessions_spawn", "delegate"],
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "delegate with octoclaw_dispatch instead of sessions_spawn" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("does not block direct tools after a reply route_hint is stored on a newer context alias", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const oldKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const aliasKey = "session-route-hint-alias";
    const now = Date.now();
    policyState.setState(oldKey, {
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    policyState.setState(aliasKey, {
      decision: {
        route_decision: { route: "reply" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: true },
        tool_policy: { allow_direct_tools: true },
      },
      routeHintSubmitted: true,
      createdAt: now,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "web_fetch", params: {} },
      { sessionKey: oldKey, sessionId: aliasKey, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(oldKey);
    policyState.clearState(aliasKey);
  });
});
