import { describe, expect, it } from "vitest";

import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";

import {
  normalizeToLiveRoute,
  resolveCurrentRouteSeal,
  validateRouteSeal,
} from "./route-seal.js";

function seal(overrides: Partial<RouteSeal> = {}): RouteSeal {
  return {
    schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
    requestId: "req-1",
    turnId: "turn-1",
    threadBindingKey: "thread-1",
    route: "delegate",
    source: "local_judge",
    reasonCodes: ["test"],
    createdAt: "2026-04-24T00:00:00.000Z",
    inputHash: "hash-1",
    stateGeneration: 1,
    ...overrides,
  };
}

describe("route-seal resolver", () => {
  it("keeps current policyJson.routeSeal over old state", () => {
    const result = resolveCurrentRouteSeal({
      requestId: "req-1",
      turnId: "turn-1",
      threadBindingKey: "thread-1",
      policyJson: { routeSeal: seal({ route: "delegate", source: "explicit_current_policy" }) },
      savedRouteSeal: seal({ route: "reply" }),
      inputHash: "hash-1",
      stateGeneration: 2,
      now: new Date("2026-04-24T00:00:01.000Z"),
    });

    expect(result.route).toBe("delegate");
    expect(result.source).toBe("explicit_current_policy");
  });

  it("preserves delegate when forceRoute and route_decision both require dispatch", () => {
    const result = resolveCurrentRouteSeal({
      requestId: "req-2",
      turnId: "turn-2",
      threadBindingKey: "thread-2",
      policyJson: {
        forceRoute: "delegate",
        route_decision: { route: "delegate" },
      },
    });

    expect(result.route).toBe("delegate");
    expect(result.source).toBe("explicit_current_policy");
  });

  it("normalizes legacy vocab for compat but never stores it as top-level route", () => {
    expect(normalizeToLiveRoute("runner")).toBe("delegate");
    expect(normalizeToLiveRoute("spawn_single")).toBe("delegate");
    expect(normalizeToLiveRoute("observe")).toBe("delegate");
    expect(normalizeToLiveRoute("direct")).toBe("reply");

    for (const legacyRoute of ["runner", "spawn_single", "observe", "direct"]) {
      const result = resolveCurrentRouteSeal({
        requestId: `req-${legacyRoute}`,
        turnId: `turn-${legacyRoute}`,
        threadBindingKey: "thread-legacy",
        policyJson: { forceRoute: legacyRoute },
      });

      expect(result.route).toBe("reply");
      expect(result.source).toBe("safe_fallback");
    }
  });

  it("does not let regex grounding terms override judge route", () => {
    const result = resolveCurrentRouteSeal({
      requestId: "req-3",
      turnId: "turn-3",
      threadBindingKey: "thread-3",
      policyJson: {
        userMessage: "runner/status/继续查",
        state_grounding: { matched: "runner/status/继续查" },
      },
      localJudgeOutput: { route: "reply", confidence: 0.91, reasonCodes: ["answer_current_turn"] },
    });

    expect(result.route).toBe("reply");
    expect(result.source).toBe("local_judge");
    expect(result.reasonCodes).toEqual(["answer_current_turn"]);
  });

  it("rejects stale route seal with mismatched turnId", () => {
    const stale = seal({ turnId: "old-turn", route: "delegate" });
    const result = resolveCurrentRouteSeal({
      requestId: "req-4",
      turnId: "turn-4",
      threadBindingKey: "thread-1",
      savedRouteSeal: stale,
    });

    expect(validateRouteSeal(stale, "turn-4", "thread-1")).toBe(false);
    expect(result.route).toBe("reply");
    expect(result.source).toBe("safe_fallback");
  });
});
