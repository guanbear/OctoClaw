import { afterEach, describe, expect, it, vi } from "vitest";

const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
});

import {
  SlackAdapter,
  auditSlackFacingToolExposure,
  isSlackTargetAllowed,
  renderSlackProjectionFooter,
} from "./slack-adapter.js";
import { ERROR_CODES } from "@octoclaw/errors";

describe("SlackAdapter", () => {
  it("declares Slack as L2 and renders projection footer inside adapter", () => {
    const adapter = new SlackAdapter();

    expect(adapter.capabilityLevel).toBe("L2");
    expect(adapter.renderProjectionFooter("北京天气很好。", {
      route: "reply",
      model: "zhipu/GLM-5.1",
      complexityBand: "deep",
      via: "judge",
      workerPool: "octoclaw-main",
      workContractId: "wc-1234567890",
      thread: true,
    })).toBe("北京天气很好。\n\n• octoclaw: route=reply | model=zhipu/GLM-5.1 | difficulty=deep · thread | via=judge | worker=octoclaw-main | wc=wc-12345");
  });

  it("resolves Slack message turn anchors from Slack ts aliases", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveMessageTurnAnchor({ metadata: { ts: "1700000000.000100" } })).toBe("1700000000.000100");
    expect(adapter.resolveMessageTurnAnchor({ metadata: { message_ts: "1700000000.000200" } })).toBe("1700000000.000200");
  });

  it("applies projection footer before Slack API send", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(String(init?.body));
      expect(body.text).toContain("• octoclaw: route=reply | model=zhipu/GLM-5.1");
      return { json: async () => ({ ok: true, ts: "1700000000.000300" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new SlackAdapter();

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: "北京天气很好。",
      projectionFooter: { route: "reply", model: "zhipu/GLM-5.1" },
    });

    expect(result.sent).toBe(true);
    expect(result.transport).toBe("slack_api");
  });

  it("does not expose runtime model profile labels in projection footers", () => {
    const adapter = new SlackAdapter();
    const rendered = adapter.renderProjectionFooter("收到。", {
      route: "reply",
      model: "direct_main",
      thread: true,
    });

    expect(rendered).toContain("route=reply | model=");
    expect(rendered).not.toContain("model=direct_main");
    expect(rendered).not.toContain("model=unknown");
  });

  it("renders router health downgrade reasons in projection footers", () => {
    expect(renderSlackProjectionFooter("done", {
      route: "delegate",
      model: "zai/glm-4.7",
      healthNote: "downgraded: rate_limit_429 on zhipu/glm-5.1",
    })).toContain("health=downgraded: rate_limit_429 on zhipu/glm-5.1");
  });

  it("sends Slack messages through Slack Web API", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
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

  it("sends Slack interactive blocks through chat.postMessage", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const blocks = [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "启用默认设置" },
            action_id: "octoclaw_router_wizard_use_defaults",
            value: "use_defaults",
          },
        ],
      },
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        text: "Auto Router wizard",
        blocks,
        thread_ts: "1700000000.000100",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000211" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: "Auto Router wizard",
      interactiveBlocks: blocks,
      deliveryKind: "router_wizard_onboarding",
      replyToMessageId: "1700000000.000100",
      suppressProjectionFooter: true,
    });

    expect(result).toMatchObject({
      sent: true,
      messageId: "1700000000.000211",
      transport: "slack_api",
    });
  });

  it("opens Slack DMs before Web API message delivery", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
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
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://slack.com/api/chat.stopStream") {
        expect(JSON.parse(String(init?.body))).toEqual({
          channel: "C123ABCDEF",
          ts: "1700000000.000220",
        });
        return { json: async () => ({ ok: true, ts: "1700000000.000220" }) } as Response;
      }
      expect(String(url)).toBe("https://slack.com/api/chat.startStream");
      const body = JSON.parse(String(init?.body));
      expect(body.channel).toBe("C123ABCDEF");
      expect(body.markdown_text).toContain("done");
      expect(body.markdown_text).toContain("route=delegate | model=zhipu/GLM-5.1 | difficulty=deep · thread | via=native_announce | wc=wc-12345");
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
        model: "worker_research",
        via: "native_announce",
        complexityBand: "deep",
        workContractId: "wc-1234567890",
      },
      footerMode: "debug",
    });

    expect(result).toMatchObject({
      ok: true,
      transport: "slack_api_stream",
      targetSource: "inbound_anchor",
      footerSource: "envelope",
    });
  });

  it("streams native child finals when Slack native streaming is enabled", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() || "";
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      if (method === "chat.startStream") {
        expect(body).toEqual({
          channel: "C123ABCDEF",
          thread_ts: "1700000000.000100",
          markdown_text: "streamed child result",
        });
        return { json: async () => ({ ok: true, channel: "C123ABCDEF", ts: "1700000000.000230" }) } as Response;
      }
      expect(method).toBe("chat.stopStream");
      expect(body).toEqual({
        channel: "C123ABCDEF",
        ts: "1700000000.000230",
      });
      return { json: async () => ({ ok: true, channel: "C123ABCDEF", ts: "1700000000.000230" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ streamingMode: "partial", nativeTransport: true });
    const result = await adapter.sendText({
      kind: "native_child_final",
      channel: "slack",
      target: {
        to: "C123ABCDEF",
        replyToMessageId: "1700000000.000100",
        source: "inbound_anchor",
      },
      content: "streamed child result",
      footerMode: "off",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "1700000000.000230",
      threadTs: "1700000000.000100",
      transport: "slack_api_stream",
      targetSource: "inbound_anchor",
    });
    expect(calls.map((call) => call.method)).toEqual(["chat.startStream", "chat.stopStream"]);
  });

  it("falls back to postMessage when native child stream start fails", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() || "";
      calls.push(method);
      const body = JSON.parse(String(init?.body));
      if (method === "chat.startStream") {
        expect(body.channel).toBe("C123ABCDEF");
        return { json: async () => ({ ok: false, error: "channel_type_not_supported" }) } as Response;
      }
      expect(method).toBe("chat.postMessage");
      expect(body).toEqual({
        channel: "C123ABCDEF",
        text: "fallback child result",
        thread_ts: "1700000000.000100",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000240" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ streamingMode: "partial", nativeTransport: true });
    const result = await adapter.sendText({
      kind: "native_child_final",
      channel: "slack",
      target: {
        to: "C123ABCDEF",
        replyToMessageId: "1700000000.000100",
        source: "inbound_anchor",
      },
      content: "fallback child result",
      footerMode: "off",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "1700000000.000240",
      transport: "slack_api",
    });
    expect(calls).toEqual(["chat.startStream", "chat.postMessage"]);
  });

  it("does not stream native child finals when Slack streaming is disabled", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        text: "plain child result",
        thread_ts: "1700000000.000100",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000250" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ streamingMode: "off", nativeTransport: true });
    const result = await adapter.sendText({
      kind: "native_child_final",
      channel: "slack",
      target: {
        to: "C123ABCDEF",
        replyToMessageId: "1700000000.000100",
        source: "inbound_anchor",
      },
      content: "plain child result",
      footerMode: "off",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "1700000000.000250",
      transport: "slack_api",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("send returns coded error for unresolvable session key", async () => {
    const adapter = new SlackAdapter();

    const result = await adapter.send({
      sessionKey: "agent:main:main",
      message: "ack",
    });

    expect(result).toMatchObject({
      sent: false,
      delivered: false,
      error: ERROR_CODES.IM_UNRESOLVABLE_TARGET,
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

  it("uses Slack Web API by default for internal ACK sends", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
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
  });

  it("sends reactions through Slack Web API", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
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
  });

  it("resolves Slack DM channel before sending reaction", async () => {
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
  });

  it("does not pass invalid Slack ts values as reply or thread ids", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (String(url) === "https://slack.com/api/conversations.open") {
        return { json: async () => ({ ok: true, channel: { id: "D123ABCDEF" } }) } as Response;
      }
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      return { json: async () => ({ ok: true, ts: "1700000000.000600" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new SlackAdapter();

    const result = await adapter.send({
      sessionKey: "agent:main:slack:default:direct:u123abcdef:thread:0",
      message: "ack",
      replyToMessageId: "0",
    });

    expect(result.sent).toBe(true);
    expect(bodies[0]).toEqual({ users: "U123ABCDEF" });
    expect(bodies[1]).toEqual({ channel: "D123ABCDEF", text: "ack" });
    expect(bodies[1]).not.toHaveProperty("thread_ts");
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

describe("Slack smoke S1-S5", () => {
  it("S1: normal reply sends and delivers successfully", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(String(init?.body));
      expect(body.channel).toBe("C123ABCDEF");
      expect(body.text).toContain("hello world");
      return { json: async () => ({ ok: true, ts: "1700000000.001001" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: "hello world",
    });

    expect(result).toMatchObject({ sent: true, delivered: true });
  });

  it("S2: delegate message with footer includes model name", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(String(init?.body));
      expect(body.text).toContain("task completed");
      expect(body.text).toContain("zhipu/GLM-5.1");
      return { json: async () => ({ ok: true, ts: "1700000000.001002" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: "task completed",
      projectionFooter: { route: "delegate", model: "zhipu/GLM-5.1", via: "native_announce" },
    });

    expect(result).toMatchObject({ sent: true, delivered: true });
  });

  it("S3: streaming transport returns native_streaming", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const method = String(url).split("/").pop() || "";
      calls.push(method);
      if (method === "chat.startStream") {
        return { json: async () => ({ ok: true, channel: "C123ABCDEF", ts: "1700000000.001003" }) } as Response;
      }
      return { json: async () => ({ ok: true, ts: "1700000000.001003" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ streamingMode: "partial", nativeTransport: true });
    const result = await adapter.sendText({
      kind: "native_child_final",
      channel: "slack",
      target: { to: "C123ABCDEF", replyToMessageId: "1700000000.000100", source: "inbound_anchor" },
      content: "streamed result",
      footerMode: "off",
    });

    expect(result).toMatchObject({ ok: true, transport: "slack_api_stream" });
  });

  it("S4: channel_not_found returns sent:false with IM_SEND_FAILED error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      return { json: async () => ({ ok: false, error: "channel_not_found" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C_NOTFOUND",
      message: "test message",
    });

    expect(result).toMatchObject({ sent: false, delivered: false });
    expect(result.error).toBeTruthy();
  });

  it("S5: long message auto-truncates and sends successfully", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const longMessage = "x".repeat(50000);
    let capturedText = "";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(String(init?.body));
      capturedText = body.text;
      return { json: async () => ({ ok: true, ts: "1700000000.001005" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abcdef",
      message: longMessage,
    });

    expect(result).toMatchObject({ sent: true, delivered: true });
    expect(capturedText.length).toBeLessThanOrEqual(40000);
  });
});
