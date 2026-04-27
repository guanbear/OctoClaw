import { describe, expect, it, vi } from "vitest";
import { buildPromptContextProjection, extractInboundMessageTimestamp, resolveDelegationCapability } from "./extension-entry.js";

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
