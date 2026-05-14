import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for env module
type MockRunCommand = (command: string, args: string[], options: unknown) => Promise<{ code: number; stdout: string; stderr: string }>;
let mockRunCommand = vi.hoisted<MockRunCommand>(() => async () => ({ code: 0, stdout: "", stderr: "" }));
vi.mock("../../resolve/env.js", () => ({
  runCommand: (...args: unknown[]) => mockRunCommand(...(args as [string, string[], unknown])),
  resolveWorkspaceRoot: () => "/workspace",
}));

// Env var save/restore
const originalLegacyDelivery = process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;

beforeEach(() => {
  mockRunCommand = async () => ({ code: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLegacyDelivery === undefined) delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
  else process.env.OCTOCLAW_LEGACY_CLI_DELIVERY = originalLegacyDelivery;
  if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
});

// IMPORT AFTER vi.mock
import { SlackAdapter } from "./slack-adapter.js";

describe("SlackAdapter smoke", () => {
  it("STB-S-001 sends a normal reply without thread through Slack Web API", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123ABCDEF",
        text: "hello",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000200" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      message: "hello",
      sessionKey: "agent:main:slack:channel:C123ABCDEF",
    });

    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe("slack_api");
  });

  it("STB-S-002 includes delegate footer model name in Slack API text", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return { json: async () => ({ ok: true, ts: "1700000000.000200" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      message: "result text",
      sessionKey: "agent:main:slack:channel:C123ABCDEF",
      projectionFooter: { route: "delegate", model: "openai/gpt-5.5" },
    });

    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as { text?: string };
    expect(body.text).toContain("gpt-5.5");
  });

  it("STB-S-003 uses streaming transport for native child final with thread", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(String(init?.body));
      if (method === "chat.startStream") {
        expect(body).toEqual({
          channel: "C123ABCDEF",
          thread_ts: "1700000000.000100",
          markdown_text: "streamed child result",
        });
        return { json: async () => ({ ok: true, ts: "1700000000.000300" }) } as Response;
      }
      expect(method).toBe("chat.stopStream");
      expect(body).toEqual({
        channel: "C123ABCDEF",
        ts: "1700000000.000300",
      });
      return { json: async () => ({ ok: true, ts: "1700000000.000300" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ streamingMode: "partial", nativeTransport: true });
    const result = await adapter.send({
      message: "streamed child result",
      sessionKey: "agent:main:slack:channel:C123ABCDEF:thread:1700000000.000100",
      deliveryKind: "native_child_final",
    });

    expect(result.transport).toContain("stream");
    expect(result.transport).toBe("slack_api_stream");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("STB-S-004 returns an error when Slack reports channel_not_found", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return { json: async () => ({ ok: false, error: "channel_not_found" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      message: "hello",
      sessionKey: "agent:main:slack:channel:C123ABCDEF",
    });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("channel_not_found");
  });

  it("STB-S-005 sends long messages in chunks no larger than Slack API limit", async () => {
    delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const sentChunks: string[] = [];

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text?: string };
      sentChunks.push(body.text ?? "");
      return { json: async () => ({ ok: true, ts: "1700000000.000200" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter();
    const result = await adapter.send({
      message: "x".repeat(50000),
      sessionKey: "agent:main:slack:channel:C123ABCDEF",
    });

    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentChunks.every((chunk) => chunk.length <= 39000)).toBe(true);
  });
});
