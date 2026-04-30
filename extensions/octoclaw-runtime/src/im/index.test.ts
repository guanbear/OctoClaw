import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ channels: { slack: { replyToMode: "first" } } })),
  },
}));

import { getAdapterForSession, registerIMAdapter, SlackAdapter, type IMAdapter } from "./index.js";
import { sendIMMessage } from "./send.js";

describe("IM adapter factory", () => {
  it("getAdapterForSession returns SlackAdapter for :slack: keys", () => {
    expect(getAdapterForSession("agent:main:slack:default:channel:C123")).toBeInstanceOf(SlackAdapter);
  });

  it("getAdapterForSession returns null for unknown keys", () => {
    expect(getAdapterForSession("agent:main:main")).toBeNull();
    expect(getAdapterForSession("agent:main:unknown:default:channel:X123")).toBeNull();
  });

  it("getAdapterForSession returns FeishuAdapter for :feishu: keys", () => {
    const result = getAdapterForSession("agent:main:feishu:default:direct:ou_abc");
    expect(result).not.toBeNull();
    expect(result?.channel).toBe("feishu");
  });

  it("getAdapterForSession returns WeChatAdapter for :wechat: keys", () => {
    const result = getAdapterForSession("agent:main:wechat:default:direct:wxid_abc");
    expect(result).not.toBeNull();
    expect(result?.channel).toBe("wechat");
  });

  it("adapter is cached", () => {
    const first = getAdapterForSession("agent:main:slack:default:channel:C123");
    const second = getAdapterForSession("agent:main:slack:default:dm:U123");

    expect(first).toBe(second);
  });



  it("sendIMMessage degrades threaded sends to plain text when thread delivery fails", async () => {
    const sentReplyTargets: Array<string | undefined> = [];
    const customAdapter: IMAdapter = {
      channel: "test",
      capabilityLevel: "L1",
      canHandle: (sessionKey) => sessionKey.startsWith("test:"),
      resolveTarget: () => ({ channel: "test", target: "T123" }),
      send: async (params) => {
        sentReplyTargets.push(params.replyToMessageId);
        if (params.replyToMessageId) return { sent: false, delivered: false, error: "thread_failed" };
        return { sent: true, delivered: true, messageId: "plain-1" };
      },
      react: async () => ({ ok: false }),
    };
    registerIMAdapter(customAdapter);

    const result = await sendIMMessage({ sessionKey: "test:channel:T123", message: "hello", replyToMessageId: "thread-1" });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("plain-1");
    expect(sentReplyTargets).toEqual(["thread-1", undefined]);
  });

  it("registerIMAdapter allows custom adapters", () => {
    const customAdapter: IMAdapter = {
      channel: "feishu",
      canHandle: (sessionKey) => sessionKey.toLowerCase().startsWith("feishu:"),
      resolveTarget: () => ({ channel: "feishu", target: "ABC123" }),
      send: async () => ({ sent: true, delivered: true }),
      react: async () => ({ ok: true }),
    };

    registerIMAdapter(customAdapter);

    expect(getAdapterForSession("feishu:user:ABC123")).toBe(customAdapter);
  });
});
