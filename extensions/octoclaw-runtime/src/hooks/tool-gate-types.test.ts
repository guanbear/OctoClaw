import { describe, expect, it } from "vitest";

import { gateAllow, gateBlock, gateObserve, type ToolGateInput, type ToolGateReplayEvent } from "./tool-gate-types.js";

describe("tool gate shared result helpers", () => {
  it("builds an allow result without blocking the tool", () => {
    expect(gateAllow()).toEqual({ kind: "allow" });
  });

  it("can mark an allow result as terminal for the orchestrator", () => {
    expect(gateAllow({ stop: true })).toEqual({ kind: "allow", stop: true });
  });

  it("builds a block result with reason, state patch, and replay events", () => {
    const replayEvent: ToolGateReplayEvent = {
      event: "tool_blocked",
      payload: { toolName: "edit" },
    };

    expect(gateBlock("must delegate first", {
      statePatch: { blockedTools: ["edit"] },
      replayEvents: [replayEvent],
    })).toEqual({
      kind: "block",
      block: true,
      blockReason: "must delegate first",
      statePatch: { blockedTools: ["edit"] },
      replayEvents: [replayEvent],
    });
  });

  it("builds an observe result that can carry state and replay side effects", () => {
    expect(gateObserve({
      statePatch: { routeHintSubmitted: true },
      replayEvents: [{ event: "route_hint_seen", payload: { route: "delegate" } }],
    })).toEqual({
      kind: "observe",
      statePatch: { routeHintSubmitted: true },
      replayEvents: [{ event: "route_hint_seen", payload: { route: "delegate" } }],
    });
  });

  it("names the common input surface each gate receives", () => {
    const input: ToolGateInput = {
      toolName: "octoclaw_dispatch",
      toolParams: { task: "implement S4" },
      event: { toolName: "octoclaw_dispatch" },
      ctx: { sessionKey: "session-1" },
      stateKey: "session-1",
      state: { decision: { route_decision: { route: "delegate" } } },
      decision: { route_decision: { route: "delegate" } },
    };

    expect(input.toolName).toBe("octoclaw_dispatch");
    expect(input.stateKey).toBe("session-1");
  });
});
