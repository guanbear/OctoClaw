import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ channels: { slack: { replyToMode: "first" } } })),
  },
}));

import { getAdapterForSession, registerIMAdapter, SlackAdapter, type IMAdapter } from "./index.js";

describe("IM adapter factory", () => {
  it("getAdapterForSession returns SlackAdapter for :slack: keys", () => {
    expect(getAdapterForSession("agent:main:slack:default:channel:C123")).toBeInstanceOf(SlackAdapter);
  });

  it("getAdapterForSession returns null for non-Slack keys", () => {
    expect(getAdapterForSession("agent:main:main")).toBeNull();
    expect(getAdapterForSession("feishu:user:ABC123")).toBeNull();
  });

  it("adapter is cached", () => {
    const first = getAdapterForSession("agent:main:slack:default:channel:C123");
    const second = getAdapterForSession("agent:main:slack:default:dm:U123");

    expect(first).toBe(second);
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
