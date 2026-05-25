import { describe, expect, it } from "vitest";

import {
  evaluateNativeAnnounceDeliveryGate,
  evaluateSessionControlGate,
} from "./session-control-gate.js";

describe("SessionControlGate", () => {
  it("allows redispatch for native announce blocker repair", () => {
    expect(evaluateNativeAnnounceDeliveryGate({
      toolName: "octoclaw_dispatch",
      state: {
        nativeAnnounceBlocked: true,
        workContractId: "wc-blocked",
      },
    })).toEqual(expect.objectContaining({
      kind: "observe",
      replayEvents: [expect.objectContaining({ event: "native_announce_blocker_redispatch_allowed" })],
      stop: true,
    }));
  });

  it("blocks dispatch and spawn during native announce completion delivery", () => {
    const result = evaluateNativeAnnounceDeliveryGate({
      toolName: "sessions_spawn",
      state: {
        nativeAnnounceDelivered: true,
        workContractId: "wc-delivered",
      },
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      blockReason: expect.stringContaining("existing native subagent completion"),
      statePatch: { blockedTools: ["sessions_spawn"] },
    });
  });

  it("allows configured control observer tools and stops later gates", () => {
    expect(evaluateSessionControlGate({
      toolName: "octoclaw_status",
      decision: { route_decision: { task_class: "control_observer", route: "reply" } },
      allowedObserverTools: new Set(["octoclaw_status"]),
      allowedSessionTools: new Set(),
      stateKey: "session-control",
      sessionId: "sid-control",
    })).toEqual({ kind: "allow", stop: true });
  });

  it("blocks non-control tools for session control decisions", () => {
    expect(evaluateSessionControlGate({
      toolName: "edit",
      decision: { route_decision: { task_class: "session_control", route: "reply" } },
      allowedObserverTools: new Set(),
      allowedSessionTools: new Set(["octoclaw_status", "session_status"]),
      stateKey: "session-control",
      sessionId: "sid-control",
    })).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw current-session control request must use session control tools only: octoclaw_status, session_status.",
      statePatch: { blockedTools: ["edit"] },
      replayEvents: [expect.objectContaining({ event: "tool_blocked_session_control" })],
    });
  });
});
