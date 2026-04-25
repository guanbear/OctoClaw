import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ channels: { slack: { replyToMode: "first" } } })),
  },
}));

import { getAdapterForSession, SlackAdapter } from "./index.js";

describe("IM adapter factory", () => {
  it("getAdapterForSession returns SlackAdapter for :slack: keys", () => {
    expect(getAdapterForSession("agent:main:slack:default:channel:C123")).toBeInstanceOf(SlackAdapter);
  });

  it("getAdapterForSession returns null for non-Slack keys", () => {
    expect(getAdapterForSession("agent:main:main")).toBeNull();
  });

  it("adapter is cached", () => {
    const first = getAdapterForSession("agent:main:slack:default:channel:C123");
    const second = getAdapterForSession("agent:main:slack:default:dm:U123");

    expect(first).toBe(second);
  });
});
