import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNeutralInboundAckDedupeForTests, updateAckTrackingState } from "./ack/ack-guard.js";
import { nativeSpawnIntentStore } from "./delegate/native-spawn-intent-store.js";
import type { IMAdapter, IMReactParams, IMSendParams } from "./im/adapter.js";
import { registerIMAdapter } from "./im/index.js";
import { fetchLatestUserMessageTsForSessionKey } from "./im/slack-thread-anchor.js";
import { envOverrides } from "./resolve/env.js";
import { plugin } from "./extension-entry.js";
import { policyState } from "./state/policy-state.js";

vi.mock("./im/slack-thread-anchor.js", () => ({
  fetchLatestUserMessageTsForSessionKey: vi.fn(async () => "1777770000.333333"),
}));

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };
let tempWorkspace = "";
let originalRuntimeDbPath: string | undefined;
let originalWorkspaceEnv: string | undefined;
let originalNeutralAckDelay: string | undefined;
let originalNeutralAckTextFallbackDelay: string | undefined;
let originalRuntimeLedger: string | undefined;

async function waitForFireAndForget(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function readReplayEvents(): Array<Record<string, unknown>> {
  const replayLogPath = path.join(tempWorkspace, "tmp", "octopus", "runtime-policy-replay.jsonl");
  if (!fsSync.existsSync(replayLogPath)) return [];
  return fsSync.readFileSync(replayLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  originalRuntimeDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
  originalWorkspaceEnv = process.env.WORKSPACE;
  originalNeutralAckDelay = process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS;
  originalNeutralAckTextFallbackDelay = process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS;
  originalRuntimeLedger = process.env.OCTOCLAW_RUNTIME_LEDGER;
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-neutral-ack-"));
  envOverrides.workspaceRoot = tempWorkspace;
  process.env.WORKSPACE = tempWorkspace;
  process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tempWorkspace, ".octoclaw", "runtime", "octoclaw-runtime.sqlite");
  process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS = "1";
  process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS = "1";
  vi.mocked(fetchLatestUserMessageTsForSessionKey).mockClear();
  vi.mocked(fetchLatestUserMessageTsForSessionKey).mockResolvedValue("1777770000.333333");
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  resetNeutralInboundAckDedupeForTests();
  envOverrides.workspaceRoot = "";
  if (originalRuntimeDbPath === undefined) delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
  else process.env.OCTOCLAW_RUNTIME_DB_PATH = originalRuntimeDbPath;
  if (originalWorkspaceEnv === undefined) delete process.env.WORKSPACE;
  else process.env.WORKSPACE = originalWorkspaceEnv;
  if (originalNeutralAckDelay === undefined) delete process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS;
  else process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS = originalNeutralAckDelay;
  if (originalNeutralAckTextFallbackDelay === undefined) delete process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS;
  else process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS = originalNeutralAckTextFallbackDelay;
  if (originalRuntimeLedger === undefined) delete process.env.OCTOCLAW_RUNTIME_LEDGER;
  else process.env.OCTOCLAW_RUNTIME_LEDGER = originalRuntimeLedger;
  originalRuntimeDbPath = undefined;
  originalWorkspaceEnv = undefined;
  originalNeutralAckDelay = undefined;
  originalNeutralAckTextFallbackDelay = undefined;
  originalRuntimeLedger = undefined;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("neutral Slack ACK hook dedupe", () => {
  it("does not suppress a new inbound Slack message because a previous message sent a reaction ACK", async () => {
    const handlers = new Map<string, Function>();
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackfresh"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackfresh" }),
      send: async () => ({ sent: true, delivered: true, messageId: "1777770001.000010" }),
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    expect(messageReceived).toBeTruthy();
    const stateKey = "agent:main:slack:default:direct:u0ackfresh";
    updateAckTrackingState(stateKey, {
      ackMessageTurnId: `${stateKey}:1777770000.000001`,
      ack_message_turn_id: `${stateKey}:1777770000.000001`,
      reactionAckSent: true,
      reaction_ack_sent: true,
    });

    messageReceived!(
      {
        content: "新的消息",
        metadata: {
          messageId: "1777770000.000002",
          originatingChannel: "slack",
          originatingTo: "user:U0ACKFRESH",
        },
      },
      {
        channelId: "slack",
        conversationId: "user:U0ACKFRESH",
      },
    );
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({
      messageId: "1777770000.000002",
      emoji: "eyes",
    });
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.replyToMessageId === "1777770000.000002")).toBe(true);
    expect(neutralAckEvents.some((entry) => entry.replyToMessageId === "1777770000.000002" && entry.reason === "reaction_ack_already_sent")).toBe(false);
  });

  it("starts a fresh turn when a new Slack DM arrives during an active delegate", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      pluginConfig: {},
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    expect(messageReceived).toBeTruthy();
    const sessionKey = "agent:main:slack:default:direct:u0turnfresh";
    policyState.setState(sessionKey, {
      prompt: "本机部署下rsshub",
      decision: {
        route_decision: { route: "delegate", route_source: "judge" },
        work_contract: {
          workContractId: "wc-rsshub-old",
          route: "delegate",
          childSessionKey: "agent:main:subagent:rsshub-old",
        },
        routeSeal: { turnId: "turn-rsshub-old" },
      },
      delegated: true,
      dispatchExecuted: true,
      dispatch_executed: true,
      spawnExecuted: true,
      spawn_executed: true,
      workContractId: "wc-rsshub-old",
      work_contract_id: "wc-rsshub-old",
      childSessionKey: "agent:main:subagent:rsshub-old",
      child_session_key: "agent:main:subagent:rsshub-old",
      inboundMessageTs: "1779717980.000001",
      replyToMessageId: "1779717980.000001",
      message_id: "1779717980.000001",
      deliveryTarget: { replyToMessageId: "1779717980.000001" },
      delivery_target: { replyToMessageId: "1779717980.000001" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    messageReceived!(
      {
        content: "Reddit API key 怎么申请",
        metadata: {
          messageId: "1779718007.000002",
          originatingChannel: "slack",
          originatingTo: "user:U0TURNFRESH",
        },
      },
      {
        sessionKey,
        channelId: "slack",
        conversationId: "user:U0TURNFRESH",
      },
    );
    await waitForFireAndForget();

    expect(policyState.getState(sessionKey)).toMatchObject({
      inboundMessageTs: "1779718007.000002",
      replyToMessageId: "1779718007.000002",
      message_id: "1779718007.000002",
    });
    const nextState = policyState.getState(sessionKey) ?? {};
    expect(nextState.decision).toBeUndefined();
    expect(nextState.delegated).toBe(false);
    expect(nextState.dispatchExecuted).toBeUndefined();
    expect(nextState.spawnExecuted).toBeUndefined();
    expect(nextState.workContractId).toBeUndefined();
    expect(nextState.childSessionKey).toBeUndefined();
  });

  it("does not suppress a new inbound Slack message because a previous message had a visible formal reply", async () => {
    const handlers = new Map<string, Function>();
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackformal"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackformal" }),
      send: async () => ({ sent: true, delivered: true, messageId: "1777770001.000011" }),
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    expect(messageReceived).toBeTruthy();
    const stateKey = "agent:main:slack:default:direct:u0ackformal";
    updateAckTrackingState(stateKey, {
      ackMessageTurnId: `${stateKey}:1777770000.000010`,
      ack_message_turn_id: `${stateKey}:1777770000.000010`,
      formal_reply_visible: true,
      formalReplyVisible: true,
      delivered: true,
      deliveryStatus: "delivered",
      delivery_status: "delivered",
      finalResponseStreaming: true,
      final_response_streaming: true,
      firstTokenSeen: true,
      first_token_seen: true,
    });

    messageReceived!(
      {
        content: "为啥没回复",
        metadata: {
          messageId: "1777770000.000011",
          originatingChannel: "slack",
          originatingTo: "user:U0ACKFORMAL",
        },
      },
      {
        channelId: "slack",
        conversationId: "user:U0ACKFORMAL",
      },
    );
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({
      messageId: "1777770000.000011",
      emoji: "eyes",
    });
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.replyToMessageId === "1777770000.000011")).toBe(true);
    expect(neutralAckEvents.some((entry) => entry.replyToMessageId === "1777770000.000011" && entry.reason === "formal_reply_visible")).toBe(false);
    expect(neutralAckEvents.some((entry) => entry.replyToMessageId === "1777770000.000011" && entry.reason === "reply_delivered")).toBe(false);
    expect(neutralAckEvents.some((entry) => entry.replyToMessageId === "1777770000.000011" && entry.reason === "reply_streaming")).toBe(false);
  });

  it("uses the inbound Slack anchor and sends only one neutral ACK across duplicate hooks", async () => {
    const handlers = new Map<string, Function>();
    const reactions: IMReactParams[] = [];
    const sends: IMSendParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0ackdedupe"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0ackdedupe", threadTs: "1777770000.111111" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000001", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    const beforeDispatch = handlers.get("before_dispatch");
    const beforePromptBuild = handlers.get("before_prompt_build");
    expect(messageReceived).toBeTruthy();
    expect(beforeDispatch).toBeTruthy();
    expect(beforePromptBuild).toBeTruthy();
    const sessionKey = "agent:main:slack:channel:c0ackdedupe:thread:1777770000.111111";
    const ctx = {
      sessionKey,
      sessionId: "neutral-dedupe-session",
      agentId: "main",
      channelId: "slack",
      inboundMessageTs: "1777770000.111111",
      cwd: tempWorkspace,
    };
    const event = {
      prompt: "在吗",
      message_ts: "1777770000.111111",
    };

    messageReceived!(
      {
        content: "在吗",
        metadata: {
          messageId: "1777770000.111111",
          originatingChannel: "slack",
          originatingTo: "channel:C0ACKDEDUPE",
        },
      },
      {
        channelId: "slack",
        conversationId: "channel:C0ACKDEDUPE",
      },
    );
    messageReceived!(
      {
        content: "在吗",
        metadata: {
          messageId: "1777770000.111111",
          originatingChannel: "slack",
          originatingTo: "channel:C0ACKDEDUPE",
        },
      },
      {
        channelId: "slack",
        conversationId: "channel:C0ACKDEDUPE",
      },
    );
    await waitForFireAndForget();
    beforeDispatch!(event, ctx);
    beforeDispatch!(event, ctx);
    await waitForFireAndForget();
    await beforePromptBuild!(event, ctx);
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({
      messageId: "1777770000.111111",
      emoji: "eyes",
    });
    expect(sends).toHaveLength(0);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.length).toBeGreaterThanOrEqual(1);
    expect(neutralAckEvents.filter((entry) => entry.sent === true)).toHaveLength(1);
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.hookName === "message_received" && entry.anchor_source === "event" && entry.fallback_used === false && entry.mode === "reaction")).toBe(true);
    expect(neutralAckEvents.every((entry) => entry.fallback_used === false)).toBe(true);
    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    const messageReceivedEvents = readReplayEvents().filter((entry) => entry.event === "message_received_observed");
    expect(messageReceivedEvents.some((entry) => entry.sessionKey === "agent:main:slack:channel:c0ackdedupe" && entry.anchor_source === "event")).toBe(true);
  });

  it("reports event anchor source when the Slack timestamp only exists on the hook event", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0ackevent"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0ackevent", threadTs: "1777770000.222222" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000002", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    expect(beforeDispatch).toBeTruthy();
    beforeDispatch!(
      { prompt: "在吗", message_ts: "1777770000.222222" },
      {
        sessionKey: "agent:main:slack:channel:c0ackevent:thread:1777770000.222222",
        sessionId: "neutral-event-source-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ messageId: "1777770000.222222" });
    expect(sends).toHaveLength(0);
    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.anchor_source === "event" && entry.fallback_used === false)).toBe(true);
    const observedEvents = readReplayEvents().filter((entry) => entry.event === "before_dispatch_observed");
    expect(observedEvents.some((entry) => entry.anchor_source === "event" && entry.inboundMessageTs === "1777770000.222222")).toBe(true);
  });

  it("uses Slack history fallback only when no inbound anchor exists", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0ackfallback"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0ackfallback" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000003", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    expect(beforeDispatch).toBeTruthy();
    beforeDispatch!(
      { prompt: "请让子 agent 处理这个没有 ts 的入口" },
      {
        sessionKey: "agent:main:slack:channel:c0ackfallback",
        sessionId: "neutral-fallback-source-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    expect(fetchLatestUserMessageTsForSessionKey).toHaveBeenCalledWith("agent:main:slack:channel:c0ackfallback", 1200);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ messageId: "1777770000.333333" });
    expect(sends).toHaveLength(0);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.anchor_source === "fallback_history" && entry.fallback_used === true)).toBe(true);
  });

  it("does not use Slack history fallback from message_received without an original anchor", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0noanchor"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0noanchor" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000006", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    expect(messageReceived).toBeTruthy();
    messageReceived!(
      {
        content: "没有 ts 的消息",
        metadata: {
          originatingChannel: "slack",
          originatingTo: "channel:C0NOANCHOR",
        },
      },
      {
        channelId: "slack",
        conversationId: "channel:C0NOANCHOR",
      },
    );
    await waitForFireAndForget();

    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    expect(reactions).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents).toHaveLength(0);
    const observedEvents = readReplayEvents().filter((entry) => entry.event === "message_received_observed");
    expect(observedEvents.some((entry) => entry.anchor_source === "none" && entry.inboundMessageTs === "")).toBe(true);
  });

  it("carries a Slack DM anchor from message_received into before_dispatch without history fallback", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackdm"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackdm" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000004", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    const beforeDispatch = handlers.get("before_dispatch");
    expect(messageReceived).toBeTruthy();
    expect(beforeDispatch).toBeTruthy();

    const sessionKey = "agent:main:slack:default:direct:u0ackdm";
    messageReceived!(
      {
        content: "你好",
        metadata: {
          messageId: "1777770000.444444",
          originatingChannel: "slack",
          originatingTo: "user:U0ACKDM",
        },
      },
      {
        channelId: "slack",
        conversationId: "user:U0ACKDM",
      },
    );
    beforeDispatch!(
      { prompt: "你好" },
      {
        sessionKey,
        sessionId: "neutral-dm-source-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ messageId: "1777770000.444444" });
    expect(sends).toHaveLength(0);
    const observedEvents = readReplayEvents().filter((entry) => entry.event === "before_dispatch_observed");
    expect(observedEvents.some((entry) => entry.sessionKey === sessionKey && entry.inboundMessageTs === "1777770000.444444" && entry.anchor_source === "ctx")).toBe(true);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.replyToMessageId === "1777770000.444444" && entry.reason !== "no_valid_thread_target")).toBe(true);
    expect(neutralAckEvents.every((entry) => entry.fallback_used === false)).toBe(true);
  });

  it("suppresses delayed neutral text ACK when the formal reply is already visible", async () => {
    process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS = "30";
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackskip"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackskip" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000005", threadTs: params.replyToMessageId };
      },
      react: async () => ({ ok: false, error: "reaction_disabled_for_test" }),
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: {},
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const messageReceived = handlers.get("message_received");
    const beforeDispatch = handlers.get("before_dispatch");
    const beforeMessageWrite = handlers.get("before_message_write");
    expect(messageReceived).toBeTruthy();
    expect(beforeDispatch).toBeTruthy();
    expect(beforeMessageWrite).toBeTruthy();

    const sessionKey = "agent:main:slack:default:direct:u0ackskip";
    messageReceived!(
      {
        content: "你好",
        metadata: {
          messageId: "1777770000.555555",
          originatingChannel: "slack",
          originatingTo: "user:U0ACKSKIP",
        },
      },
      { channelId: "slack", conversationId: "user:U0ACKSKIP" },
    );
    beforeDispatch!(
      { prompt: "你好" },
      { sessionKey, sessionId: "neutral-suppressed-session", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    beforeMessageWrite!(
      { message: { role: "assistant", content: "你好 guan，我在。" } },
      { sessionKey, sessionId: "neutral-suppressed-session", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await waitForFireAndForget();

    expect(sends).toHaveLength(0);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === false && ["reply_streaming", "formal_reply_visible"].includes(String(entry.reason)))).toBe(true);
  });

  it("sends one delayed text fallback when reaction ACK fails and no reply is visible", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackfallbacktext"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackfallbacktext" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000007", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: false, error: "reaction_disabled_for_test" };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    expect(beforeDispatch).toBeTruthy();
    beforeDispatch!(
      { prompt: "这个任务会慢一点", message_ts: "1777770000.666666" },
      {
        sessionKey: "agent:main:slack:default:direct:u0ackfallbacktext",
        sessionId: "neutral-text-fallback-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      message: "收到，正在判断并准备处理。",
      replyToMessageId: "1777770000.666666",
      suppressProjectionFooter: true,
    });
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === false && entry.reason === "reaction_ack_failed_no_text_fallback")).toBe(true);
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.mode === "text" && entry.fallback_stage === "text_after_reaction_failed")).toBe(true);
  });

  it("cancels delayed text fallback when a formal reply starts after reaction ACK fails", async () => {
    process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS = "30";
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const reactions: IMReactParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("u0ackfallbackcancel"),
      resolveTarget: () => ({ channel: "slack", target: "user:u0ackfallbackcancel" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000008", threadTs: params.replyToMessageId };
      },
      react: async (params) => {
        reactions.push(params);
        return { ok: false, error: "reaction_disabled_for_test" };
      },
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeDispatch).toBeTruthy();
    expect(beforeMessageWrite).toBeTruthy();
    const sessionKey = "agent:main:slack:default:direct:u0ackfallbackcancel";
    beforeDispatch!(
      { prompt: "这个任务会慢一点", message_ts: "1777770000.777777" },
      {
        sessionKey,
        sessionId: "neutral-text-fallback-cancel-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    beforeMessageWrite!(
      { message: { role: "assistant", content: "正式回复开始。" } },
      { sessionKey, sessionId: "neutral-text-fallback-cancel-session", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForFireAndForget();

    expect(reactions).toHaveLength(1);
    expect(sends).toHaveLength(0);
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === false && entry.reason === "reaction_ack_failed_no_text_fallback")).toBe(true);
    expect(neutralAckEvents.some((entry) => entry.sent === false && entry.reason === "reply_streaming" && entry.fallback_stage === "text_after_reaction_failed")).toBe(true);
  });

  it("handles explicit OctoClaw status commands from before_dispatch content without model dispatch", async () => {
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    const handlers = new Map<string, Function>();
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0statusfastpath"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0statusfastpath", threadTs: "1777770000.888888" }),
      send: async () => ({ sent: true, delivered: true, messageId: "1777770001.000009" }),
      react: async () => ({ ok: true }),
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    expect(beforeDispatch).toBeTruthy();
    const result = await beforeDispatch!(
      { content: "八爪鱼状态", message_ts: "1777770000.888888" },
      {
        sessionKey: "agent:main:slack:channel:c0statusfastpath:thread:1777770000.888888",
        sessionId: "status-fast-path-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    expect(result).toMatchObject({ handled: true });
    expect(result.text).toContain("八爪鱼状态");
    expect(result.text).toContain("暂无任务");
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents).toHaveLength(0);
    const statusEvents = readReplayEvents().filter((entry) => entry.event === "status_fast_path_handled");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      trigger: "八爪鱼状态",
      format: "anchors",
      imType: "slack",
      handled: true,
    });
  });

  it("handles exact task details commands before neutral ack or model dispatch", async () => {
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    const taskStatePath = path.join(tempWorkspace, "tmp", "octopus", "task-state.json");
    fsSync.mkdirSync(path.dirname(taskStatePath), { recursive: true });
    fsSync.writeFileSync(taskStatePath, JSON.stringify({
      schemaVersion: "octoclaw.task_state.v1",
      updatedAt: "2026-05-12T08:17:00.000Z",
      tasks: [{
        id: "wc-cd096bf3039cf9f0",
        workContractId: "wc-cd096bf3039cf9f0",
        work_contract_id: "wc-cd096bf3039cf9f0",
        route: "delegate",
        status: "completed",
        summary: "Readonly watchdog summary completed",
        dispatchExecuted: true,
        dispatch_executed: true,
        spawnExecuted: true,
        spawn_executed: true,
        resultMaterialized: true,
        result_materialized: true,
        delivery_status: "delivered",
        delivery: {
          status: "delivered",
          resultHash: "f1c04ee36a4f1a42",
          messageId: "1778573724.032469",
        },
        updated_at: "2026-05-12T08:16:00.000Z",
        completed_at: "2026-05-12T08:16:00.000Z",
      }],
    }, null, 2));

    const handlers = new Map<string, Function>();
    plugin.register({
      pluginConfig: { ackReactionEmoji: "eyes" },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeDispatch = handlers.get("before_dispatch");
    expect(beforeDispatch).toBeTruthy();
    const result = await beforeDispatch!(
      { content: "查看任务 wc=wc-cd096 详情", message_ts: "1777770000.999999" },
      {
        sessionKey: "agent:main:slack:channel:c0taskdetails:thread:1777770000.999999",
        sessionId: "task-details-fast-path-session",
        agentId: "main",
        channelId: "slack",
        cwd: tempWorkspace,
      },
    );
    await waitForFireAndForget();

    expect(result).toMatchObject({ handled: true });
    expect(result.text).toContain("Task: wc-cd096bf3039cf9f0");
    expect(result.text).toContain("Status: delivered");
    expect(result.text).toContain("Delivery: delivered");
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents).toHaveLength(0);
    const taskEvents = readReplayEvents().filter((entry) => entry.event === "task_action_fast_path_handled");
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toMatchObject({
      action: "details",
      taskId: "wc-cd096",
      resolvedTaskId: "wc-cd096bf3039cf9f0",
      found: true,
      handled: true,
    });
  });
});
