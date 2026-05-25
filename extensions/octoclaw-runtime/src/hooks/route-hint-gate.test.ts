import { describe, expect, it } from "vitest";

import { evaluateRouteHintGate, shouldBindRouteHintPrompt } from "./route-hint-gate.js";

describe("RouteHintGate", () => {
  const baseInput = {
    stateKey: "session-key",
    sessionId: "session-id",
    routeHintTool: "octoclaw_route_hint",
    allowedPreHintTools: new Set(["octoclaw_route_hint", "octoclaw_status"]),
  };

  it("identifies the configured route hint tool for prompt binding", () => {
    expect(shouldBindRouteHintPrompt("octoclaw_route_hint")).toBe(true);
    expect(shouldBindRouteHintPrompt("custom_route_hint", "custom_route_hint")).toBe(true);
    expect(shouldBindRouteHintPrompt("octoclaw_dispatch")).toBe(false);
  });

  it("records advisory replay instead of blocking octoclaw_dispatch by default", () => {
    expect(evaluateRouteHintGate({
      ...baseInput,
      toolName: "octoclaw_dispatch",
      decision: { route_decision: { route: "delegate" } },
      routeHintIsRequired: true,
      routeHintAlreadySubmitted: false,
      directReplyToolsAllowed: false,
    })).toMatchObject({
      kind: "observe",
      stop: false,
      replayEvents: [expect.objectContaining({
        event: "route_hint_dispatch_advisory",
      })],
    });
  });

  it("blocks ordinary tools before a required route hint", () => {
    expect(evaluateRouteHintGate({
      ...baseInput,
      toolName: "edit",
      decision: { route_decision: { route: "delegate" } },
      routeHintIsRequired: true,
      routeHintAlreadySubmitted: false,
      directReplyToolsAllowed: false,
    })).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw runtime policy requires octoclaw_route_hint before using other tools.",
      statePatch: { blockedTools: ["edit"] },
      replayEvents: [expect.objectContaining({
        event: "tool_blocked_before_route_hint",
      })],
    });
  });

  it("allows pre-hint control tools and already submitted hints", () => {
    expect(evaluateRouteHintGate({
      ...baseInput,
      toolName: "octoclaw_status",
      decision: { route_decision: { route: "delegate" } },
      routeHintIsRequired: true,
      routeHintAlreadySubmitted: false,
      directReplyToolsAllowed: false,
    })).toEqual({ kind: "allow" });

    expect(evaluateRouteHintGate({
      ...baseInput,
      toolName: "edit",
      decision: { route_decision: { route: "delegate" } },
      routeHintIsRequired: true,
      routeHintAlreadySubmitted: true,
      directReplyToolsAllowed: false,
    })).toEqual({ kind: "allow" });
  });
});
