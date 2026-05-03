import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNeutralInboundAckDedupeForTests } from "./ack/ack-guard.js";
import { nativeSpawnIntentStore } from "./delegate/native-spawn-intent-store.js";
import type { IMAdapter, IMReactParams, IMSendParams } from "./im/adapter.js";
import { registerIMAdapter } from "./im/index.js";
import { fetchLatestUserMessageTsForSessionKey } from "./im/slack-thread-anchor.js";
import { envOverrides } from "./resolve/env.js";
import { plugin } from "./extension-entry.js";

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

async function waitForFireAndForget(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-neutral-ack-"));
  envOverrides.workspaceRoot = tempWorkspace;
  process.env.WORKSPACE = tempWorkspace;
  process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tempWorkspace, ".octoclaw", "runtime", "octoclaw-runtime.sqlite");
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
  originalRuntimeDbPath = undefined;
  originalWorkspaceEnv = undefined;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("neutral Slack ACK hook dedupe", () => {
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

    expect(reactions).toHaveLength(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      message: "收到，正在判断并准备处理。",
      replyToMessageId: "1777770000.111111",
      suppressProjectionFooter: true,
    });
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.length).toBeGreaterThanOrEqual(1);
    expect(neutralAckEvents.filter((entry) => entry.sent === true)).toHaveLength(1);
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.hookName === "message_received" && entry.anchor_source === "event" && entry.fallback_used === false)).toBe(true);
    expect(neutralAckEvents.every((entry) => entry.fallback_used === false)).toBe(true);
    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    const messageReceivedEvents = readReplayEvents().filter((entry) => entry.event === "message_received_observed");
    expect(messageReceivedEvents.some((entry) => entry.sessionKey === "agent:main:slack:channel:c0ackdedupe" && entry.anchor_source === "event")).toBe(true);
  });

  it("reports event anchor source when the Slack timestamp only exists on the hook event", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0ackevent"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0ackevent", threadTs: "1777770000.222222" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000002", threadTs: params.replyToMessageId };
      },
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

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ replyToMessageId: "1777770000.222222" });
    expect(fetchLatestUserMessageTsForSessionKey).not.toHaveBeenCalled();
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.anchor_source === "event" && entry.fallback_used === false)).toBe(true);
    const observedEvents = readReplayEvents().filter((entry) => entry.event === "before_dispatch_observed");
    expect(observedEvents.some((entry) => entry.anchor_source === "event" && entry.inboundMessageTs === "1777770000.222222")).toBe(true);
  });

  it("uses Slack history fallback only when no inbound anchor exists", async () => {
    const handlers = new Map<string, Function>();
    const sends: IMSendParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("c0ackfallback"),
      resolveTarget: () => ({ channel: "slack", target: "channel:c0ackfallback" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000003", threadTs: params.replyToMessageId };
      },
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
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ replyToMessageId: "1777770000.333333" });
    const neutralAckEvents = readReplayEvents().filter((entry) => entry.event === "neutral_inbound_ack");
    expect(neutralAckEvents.some((entry) => entry.sent === true && entry.anchor_source === "fallback_history" && entry.fallback_used === true)).toBe(true);
  });
});
