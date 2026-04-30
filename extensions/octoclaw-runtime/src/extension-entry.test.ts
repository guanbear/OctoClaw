import { describe, expect, it, vi } from "vitest";
import { buildPromptContextProjection, extractInboundMessageTimestamp, guardOutboundMessageForPolicyState, plugin, resolveDelegationCapability, resolveReactionAckConfig } from "./extension-entry.js";
import { guardAssistantMessageForPolicyState } from "./replay/message-guard.js";
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


describe("resolveReactionAckConfig", () => {
  it("enables reaction ACK from top-level plugin config without judgeFast", () => {
    expect(resolveReactionAckConfig({ ackReactionEmoji: "eyes" }, {})).toEqual({
      reactionEmoji: "eyes",
      reactionAckEnabled: true,
    });
  });

  it("keeps judgeFast ackReactionEmoji as a backwards-compatible fallback", () => {
    expect(resolveReactionAckConfig({}, { ackReactionEmoji: "ok_hand" })).toEqual({
      reactionEmoji: "ok_hand",
      reactionAckEnabled: true,
    });
    expect(resolveReactionAckConfig({ ackReactionEmoji: "" }, { ackReactionEmoji: "ok_hand" })).toEqual({
      reactionEmoji: "ok_hand",
      reactionAckEnabled: true,
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
    expect(guarded?.content).toContain("route=delegate | model=");
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
    expect(guarded?.content).toContain("route=delegate | model=");
    expect(guarded?.content).toContain("· thread");
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
    expect(guarded?.content).toContain("route=reply | model=");
    expect(guarded?.content).toContain("· thread");
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


  it("cancels short model ACK text on visible Slack delivery", () => {
    const guarded = guardOutboundMessageForPolicyState(
      { to: "D0AR3GTPYQL", content: "我查一下北京今晚实时/预测交通和节前出行信息，再给你判断。", metadata: { channelId: "D0AR3GTPYQL", threadTs: "1777546854.745559" } },
      { channelId: "slack" },
      Date.now(),
    );

    expect(guarded).toEqual({ cancel: true });
  });

  it("uses bullet compact footer so OpenClaw Slack normalizer does not rewrite it", () => {
    const guarded = guardOutboundMessageForPolicyState(
      { to: "D0AR3GTPYQL", content: "北京今天整体天气不错。", metadata: { channelId: "D0AR3GTPYQL" } },
      { channelId: "slack" },
      Date.now(),
    );

    expect(guarded?.content).toContain("\n\n• route=reply | model=zhipu/GLM-5.1");
    expect(guarded?.content).not.toContain("model=unknown");
  });

  it("appends a conservative footer for visible Slack delivery when state is missing", () => {
    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0AS4DAPPU3", content: "收到。", metadata: { channelId: "C0AS4DAPPU3", threadTs: "1777387367.594319" } },
      { channelId: "slack", model: "GLM-5.1" },
      Date.now(),
    );

    expect(guarded?.content).toContain("收到。");
    expect(guarded?.content).toContain("route=reply | model=GLM-5.1 · thread");
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
    expect(guarded?.content).toContain("route=reply | model=GLM-5.1 · thread");
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
    expect(guarded?.content).toContain("route=reply | model=");
    expect(guarded?.content).toContain("· thread");
    policyState.clearState(key);
  });

  it("emits compact footer with route and model only plus · thread suffix", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0footer";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "reply" },
        model_policy: { selected_model: "zhipu/GLM-5.1" },
        request: { metadata: { message_id: "1777380000.000001" } },
      },
      inboundMessageTs: "1777380000.000001",
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0FOOTER", content: "摘要回复。", metadata: { channelId: "C0FOOTER", threadTs: "1777380000.000001" } },
      { channelId: "slack", model: "zhipu/GLM-5.1" },
      now,
    );

    expect(guarded?.content).toContain("摘要回复。");
    expect(guarded?.content).toContain("route=reply | model=zhipu/GLM-5.1 · thread");
    expect(guarded?.content).not.toContain("OctoClaw 投影");
    expect(guarded?.content).not.toContain("证据投影");
    expect(guarded?.content).not.toContain("WorkContract");
    policyState.clearState(key);
  });

  it("does not duplicate compact footer on outbound delivery when content already has route | model", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:c0dedup";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "reply" },
        model_policy: { selected_model: "model-x" },
      },
      createdAt: now,
      updatedAt: now,
    });

    const guarded = guardOutboundMessageForPolicyState(
      { to: "C0DEDUP", content: "完成。\nroute=reply | model=model-x · thread", metadata: { channelId: "C0DEDUP", threadTs: "1777390000.000001" } },
      { channelId: "slack" },
      now,
    );

    expect(guarded).toBeUndefined();
    policyState.clearState(key);
  });

  it("does not duplicate compact footer via policy guard when content already has route | model", () => {
    const guarded = guardAssistantMessageForPolicyState(
      { role: "assistant", content: "收到。\nroute=reply | model=direct_main · thread" },
      {
        decision: {
          route_decision: { route: "reply", route_source: "policy_rule" },
          router_decision_v2: { request_kind: "status_or_provenance" },
          work_contract: { workContractId: "wc-dedup", route: "reply", decisionSource: "execution_coverage" },
          model_policy: { selected_model: "direct_main" },
          _execution_coverage_packet: { replyMode: "answer", coverage: { execution: { coverage: "thread" } } },
        },
      },
    );

    expect(guarded.mode).toBe("pass");
    expect(String(guarded.message?.content)).toContain("route=reply | model=direct_main · thread");
    const footerMatches = String(guarded.message?.content).match(/route=reply \| model=direct_main/g);
    expect(footerMatches).toHaveLength(1);
  });

  it("before_message_write appends fallback footer when policy state is missing", () => {
    const previous = process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = "1";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeMessageWrite).toBeTruthy();
    const result = beforeMessageWrite!(
      { message: { role: "assistant", content: "这是最终回复。" } },
      { sessionKey: "agent:main:slack:default:direct:u0footer", agentId: "main", channelId: "slack", model: "GLM-5.1", inboundMessageTs: "1777390000.000001" },
    );

    expect(String(result?.message?.content)).toContain("这是最终回复。");
    expect(String(result?.message?.content)).toContain("route=reply | model=GLM-5.1 · thread");

    if (previous === undefined) delete process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    else process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = previous;
  });


  it("before_message_write does not append fallback footer to NO_REPLY without policy state", () => {
    const previous = process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = "1";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeMessageWrite).toBeTruthy();
    const result = beforeMessageWrite!(
      { message: { role: "assistant", content: " NO_REPLY " } },
      { sessionKey: "agent:main:slack:default:direct:u0footer", agentId: "main", channelId: "slack", model: "GLM-5.1", inboundMessageTs: "1777390000.000001" },
    );

    expect(result).toBeUndefined();

    if (previous === undefined) delete process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER;
    else process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER = previous;
  });


  it("before_message_write suppresses short model ACK before tool calls", () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeMessageWrite).toBeTruthy();
    const result = beforeMessageWrite!(
      { message: { role: "assistant", content: "我查一下北京今晚交通，再给你判断。", stopReason: "tool_calls" } },
      { sessionKey: "agent:main:slack:default:direct:u0footer", agentId: "main", channelId: "slack", model: "GLM-5.1", inboundMessageTs: "1777390000.000001" },
    );

    expect(String(result?.message?.content)).toBe("NO_REPLY");
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


describe("plugin enabled config", () => {
  it("does not register hooks or tools when disabled", () => {
    const on = vi.fn();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const info = vi.fn();

    plugin.register({
      pluginConfig: { enabled: false },
      on,
      registerTool,
      registerCommand,
      logger: { info },
    });

    expect(on).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("octoclaw-runtime: disabled via config (enabled=false), skipping hook registration");
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



  it("allows direct tools when tool policy says direct tools are allowed even if route alias is stale", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:default:direct:u0al9t5u89z:thread:t-stale";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate", route_source: "stale_alias" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "write", params: { path: "docs/example.md" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("allows direct tools for a sealed reply route even when route_hint_required remains true", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-direct";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "reply", route_source: "work_contract" },
        work_contract: { route: "reply", allowedTools: ["read", "write", "exec"] },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "read", params: { path: "docs/example.md" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("uses the dispatch task policy context over a stale reply WorkContract", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const staleKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const delegateKey = "route-hint:openclaw-latest";
    const now = Date.now();
    policyState.setState(staleKey, {
      prompt: "刚才那个任务状态",
      decision: {
        route_decision: { route: "reply" },
        work_contract: { route: "reply", forbiddenTools: ["octoclaw_dispatch", "spawn"] },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: { allow_direct_tools: true },
      },
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    policyState.setState(delegateKey, {
      prompt: "查询 OpenClaw 最新版 release notes / changelog，总结新特性。",
      decision: {
        route_decision: { route: "delegate", route_source: "rule" },
        work_contract: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      routeHintSubmitted: true,
      createdAt: now,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "查询 OpenClaw 最新版 release notes / changelog，总结新特性。请给来源。" } },
      { sessionKey: staleKey, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(staleKey);
    policyState.clearState(delegateKey);
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
