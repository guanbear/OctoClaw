import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockRunCommand = (command: string, args: string[], options: unknown) => Promise<{ code: number; stdout: string; stderr: string }>;

let mockRunCommand = vi.hoisted<MockRunCommand>(() => async () => ({ code: 0, stdout: "", stderr: "" }));
vi.mock("../../resolve/env.js", () => ({
  runCommand: (...args: unknown[]) => mockRunCommand(...(args as [string, string[], unknown])),
  resolveWorkspaceRoot: () => "/workspace",
}));

const originalLegacyDelivery = process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;

beforeEach(() => {
  mockRunCommand = async () => ({ code: 0, stdout: "", stderr: "" });
  process.env.OCTOCLAW_LEGACY_CLI_DELIVERY = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLegacyDelivery === undefined) delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
  else process.env.OCTOCLAW_LEGACY_CLI_DELIVERY = originalLegacyDelivery;
  if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
});

import {
  SlackAdapter,
  auditSlackFacingToolExposure,
  isSlackTargetAllowed,
} from "./slack-adapter.js";

describe("SlackAdapter", () => {
  it("declares Slack as L2 and renders projection footer inside adapter", () => {
    const adapter = new SlackAdapter();

    expect(adapter.capabilityLevel).toBe("L2");
    expect(adapter.renderProjectionFooter("北京天气很好。", {
      route: "reply",
      model: "zhipu/GLM-5.1",
      via: "judge",
      workerPool: "octoclaw-main",
      workContractId: "wc-1234567890",
      thread: true,
    })).toBe("北京天气很好。\n\n• route=reply | model=zhipu/GLM-5.1 · thread | via=judge | worker=octoclaw-main | wc=wc-12345");
  });

  it("resolves Slack message turn anchors from Slack ts aliases", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveMessageTurnAnchor({ metadata: { ts: "1700000000.000100" } })).toBe("1700000000.000100");
    expect(adapter.resolveMessageTurnAnchor({ metadata: { message_ts: "1700000000.000200" } })).toBe("1700000000.000200");
  });

  it("applies projection footer before Slack CLI send", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async (_command, args) => {
      const messageIndex = args.indexOf("--message");
      expect(messageIndex).toBeGreaterThan(-1);
      expect(args[messageIndex + 1]).toContain("• route=reply | model=zhipu/GLM-5.1");
      return { code: 0, stdout: JSON.stringify({ ok: true, ts: "1700000000.000300" }), stderr: "" };
    };

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "北京天气很好。",
      projectionFooter: { route: "reply", model: "zhipu/GLM-5.1" },
    });

    expect(result.sent).toBe(true);
  });

  it("sends Slack messages through Slack Web API by default without invoking OpenClaw CLI", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    mockRunCommand = async () => { throw new Error("openclaw cli should not be used by default"); };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        text: "ack",
        thread_ts: "1700000000.000100",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000200" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: "ack",
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000200",
      threadTs: "1700000000.000100",
      transport: "slack_api",
      targetSource: "inbound_anchor",
      footerSource: "none",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("opens Slack DMs before Web API message delivery", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    mockRunCommand = async () => { throw new Error("openclaw cli should not be used by default"); };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://slack.com/api/conversations.open") {
        expect(JSON.parse(String(init?.body))).toEqual({ users: "U123ABCDEF" });
        return { json: async () => ({ ok: true, channel: { id: "D123ABCDEF" } }) } as Response;
      }
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "D123ABCDEF",
        text: "dm ack",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000210" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:default:direct:u123abcdef",
      message: "dm ack",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000210",
      transport: "slack_api",
      targetSource: "session_fallback",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders debug footer from delivery envelope provenance", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(String(init?.body));
      expect(body.channel).toBe("C123ABCDEF");
      expect(body.text).toContain("done");
      expect(body.text).toContain("route=delegate | model=direct_main · thread | via=native_announce | wc=wc-12345");
      expect(body.thread_ts).toBe("1700000000.000100");
      return { json: async () => ({ ok: true, ts: "1700000000.000220" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.sendText({
      kind: "native_child_final",
      channel: "slack",
      target: {
        to: "C123ABCDEF",
        replyToMessageId: "1700000000.000100",
        source: "inbound_anchor",
      },
      content: "done",
      provenance: {
        route: "delegate",
        via: "native_announce",
        workContractId: "wc-1234567890",
      },
      footerMode: "debug",
    });

    expect(result).toMatchObject({
      ok: true,
      transport: "slack_api",
      targetSource: "inbound_anchor",
      footerSource: "envelope",
    });
  });

  it("resolveTarget parses Slack channel+thread session keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("slack:default:channel:C123abc:thread:171.22")).toEqual({
      channel: "slack",
      target: "C123ABC",
      threadTs: "171.22",
    });
  });

  it("resolveTarget parses Slack DM session keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("agent:main:slack:default:dm:u123abc")).toEqual({
      channel: "slack",
      target: "U123ABC",
    });
  });

  it("resolveTarget returns empty target for non-Slack keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("agent:main:main")).toEqual({
      channel: "slack",
      target: "",
    });
  });

  it("normalizeUserId strips user: prefix and uppercases", () => {
    const adapter = new SlackAdapter();

    expect(adapter.normalizeUserId("user:u123abc")).toBe("U123ABC");
  });

  it("extractMessageTs reads ts/messageTs/messageId", () => {
    const adapter = new SlackAdapter();

    expect(adapter.extractMessageTs({ ts: "111.222" })).toBe("111.222");
    expect(adapter.extractMessageTs({ messageTs: "333.444" })).toBe("333.444");
    expect(adapter.extractMessageTs({ messageId: "555.666" })).toBe("555.666");
  });

  it("treats stdout ok as delivered even when stderr logs make command nonzero", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 1,
      stdout: JSON.stringify({ ok: true, ts: "1700000000.000200", thread_ts: "1700000000.000100" }),
      stderr: "[octoclaw-judge] noisy stderr",
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000200",
      threadTs: "1700000000.000100",
    });
  });

  it("treats OpenClaw nested payload ok:true as delivered", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 1,
      stdout: JSON.stringify({
        action: "send",
        channel: "slack",
        payload: { ok: true, result: { messageId: "1700000000.000500", channelId: "C123ABC" } },
      }),
      stderr: "",
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000500",
    });
  });

  it("returns sent:false for OpenClaw nested payload ok:false", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 0,
      stdout: JSON.stringify({
        action: "send",
        channel: "slack",
        payload: { ok: false, error: "channel_not_found" },
      }),
      stderr: "",
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: false,
      delivered: false,
      error: "channel_not_found",
    });
  });

  it("treats stderr ok:true JSON as delivered when stdout is empty", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 1,
      stdout: "",
      stderr: `info: dispatching message\n{"ok":true,"ts":"1700000000.000300","thread_ts":"1700000000.000100"}\ninfo: done`,
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000300",
      threadTs: "1700000000.000100",
    });
  });

  it("uses Slack Web API by default for internal ACK sends", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    mockRunCommand = async () => { throw new Error("openclaw cli should not be used for internal ACK sends"); };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        text: "收到，正在判断并准备处理。",
        thread_ts: "1700000000.000100",
      });
      return {
        json: async () => ({ ok: true, ts: "1700000000.000200", message: { ts: "1700000000.000200", thread_ts: "1700000000.000100" } }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef:thread:1700000000.000100",
      message: "收到，正在判断并准备处理。",
      replyToMessageId: "1700000000.000100",
      suppressProjectionFooter: true,
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000200",
      threadTs: "1700000000.000100",
      transport: "slack_api",
      targetSource: "inbound_anchor",
      footerSource: "none",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousToken;
  });

  it("extracts ok:true from noisy stderr with surrounding log lines", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 2,
      stdout: "some stdout noise",
      stderr: `[debug] sending to slack...\n[warn] something minor\n{"ok":true,"message":{"ts":"1700000000.000400"},"ts":"1700000000.000400"}\n[debug] finished`,
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: true,
      delivered: true,
      messageId: "1700000000.000400",
    });
  });

  it("returns sent:false when no ok:true evidence and exit code nonzero", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 1,
      stdout: "[info] attempted send",
      stderr: `error: connection timeout\n{"ok":false,"error":"channel_not_found"}`,
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: false,
      delivered: false,
      error: expect.stringContaining("channel_not_found"),
    });
  });

  it("returns sent:false when stdout has ok:false with error and exit code 0", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: "channel_not_found" }),
      stderr: "",
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: false,
      delivered: false,
      error: "channel_not_found",
    });
  });

  it("sends reactions through Slack Web API without invoking OpenClaw CLI", async () => {
    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    mockRunCommand = async () => { throw new Error("openclaw cli should not be used for reactions"); };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/reactions.add");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        timestamp: "1700000000.000100",
        name: "eyes",
      });
      return { json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.react({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      messageId: "1700000000.000100",
      emoji: ":eyes:",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousToken;
  });

  it("resolves Slack DM channel before sending reaction", async () => {
    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://slack.com/api/conversations.open") {
        expect(JSON.parse(String(init?.body))).toEqual({ users: "U123ABCDEF" });
        return { json: async () => ({ ok: true, channel: { id: "D123ABCDEF" } }) } as Response;
      }
      expect(String(url)).toBe("https://slack.com/api/reactions.add");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "D123ABCDEF",
        timestamp: "1700000000.000100",
        name: "eyes",
      });
      return { json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.react({
      sessionKey: "agent:main:slack:default:direct:u123abcdef",
      messageId: "1700000000.000100",
      emoji: "eyes",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousToken;
  });

  it("does not pass invalid Slack ts values as reply or thread ids", async () => {
    const adapter = new SlackAdapter();
    let capturedArgs: string[] = [];
    mockRunCommand = async (_command, args) => {
      capturedArgs = args;
      return { code: 0, stdout: JSON.stringify({ ok: true, ts: "1700000000.000600" }), stderr: "" };
    };

    const result = await adapter.send({
      sessionKey: "agent:main:slack:default:direct:u123abc:thread:0",
      message: "ack",
      replyToMessageId: "0",
    });

    expect(result.sent).toBe(true);
    expect(capturedArgs).not.toContain("--reply-to");
    expect(capturedArgs).not.toContain("--thread-id");
  });

  it("shouldUseThread respects replyToMode config", () => {
    expect(new SlackAdapter({ replyToMode: "off" }).shouldUseThread()).toBe(false);
    expect(new SlackAdapter({ replyToMode: "first" }).shouldUseThread()).toBe(true);
    expect(new SlackAdapter({ replyToMode: "all" }).shouldUseThread()).toBe(true);
  });

  it("isStreamingAvailable checks nativeTransport and streamingMode", () => {
    expect(new SlackAdapter({ nativeTransport: true, streamingMode: "partial" }).isStreamingAvailable()).toBe(true);
    expect(new SlackAdapter({ nativeTransport: false, streamingMode: "partial" }).isStreamingAvailable()).toBe(false);
    expect(new SlackAdapter({ nativeTransport: true, streamingMode: "off" }).isStreamingAvailable()).toBe(false);
  });
});

describe("Slack adapter acceptance", () => {
  it("enforces groupPolicy allowlist for Slack channel/group delivery", () => {
    expect(isSlackTargetAllowed("slack:default:dm:U123", { allowDms: true })).toBe(true);
    expect(isSlackTargetAllowed("slack:default:dm:U123", { allowDms: false })).toBe(false);
    expect(isSlackTargetAllowed("slack:default:channel:C_ALLOWED", { allowlist: ["C_ALLOWED"] })).toBe(true);
    expect(isSlackTargetAllowed("slack:default:channel:C_BLOCKED", { allowlist: ["C_ALLOWED"] })).toBe(false);
  });

  it("audits Slack-facing tool exposure to safe message operations only", () => {
    expect(auditSlackFacingToolExposure(["message.send", "message.react"])).toEqual({
      allowed: true,
      exposedTools: ["message.send", "message.react"],
      blockedTools: [],
    });
    expect(auditSlackFacingToolExposure(["message.send", "shell.exec"])).toEqual({
      allowed: false,
      exposedTools: ["message.send", "shell.exec"],
      blockedTools: ["shell.exec"],
    });
  });
});
