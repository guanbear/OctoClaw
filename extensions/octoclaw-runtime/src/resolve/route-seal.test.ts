import { describe, expect, it } from "vitest";

import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";

import {
  normalizeToLiveRoute,
  resolveCurrentRouteSeal,
  validateRouteSeal,
} from "./route-seal.js";
import { resolvePolicyDecisionForContext } from "./policy-resolver.js";
import { policyState } from "../state/policy-state.js";
import { validCachedRouteSeal } from "../tools/registration.js";

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

  it("normalizes legacy runner route_decision route to delegate", () => {
    const result = resolveCurrentRouteSeal({
      requestId: "req-runner",
      turnId: "turn-runner",
      threadBindingKey: "thread-runner",
      policyJson: { route_decision: { route: "runner" } },
    });

    expect(result.route).toBe("delegate");
    expect(result.source).toBe("local_judge");
  });

  it("normalizes legacy spawn_single route_decision route to delegate", () => {
    const result = resolveCurrentRouteSeal({
      requestId: "req-spawn-single",
      turnId: "turn-spawn-single",
      threadBindingKey: "thread-spawn-single",
      policyJson: { route_decision: { route: "spawn_single" } },
    });

    expect(result.route).toBe("delegate");
    expect(result.source).toBe("local_judge");
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

  it("stamps routeSeal in policy state during policy resolver integration", async () => {
    const ctx = {
      sessionKey: "agent:main:slack:default:direct:u-route-seal",
      sessionId: "session-route-seal",
      agentId: "main",
      messageId: "message-route-seal",
    };
    policyState.clear(ctx.sessionKey);

    const result = await resolvePolicyDecisionForContext("Summarize this simple question", ctx, "/tmp");
    const stampedRouteSeal = result?.state.routeSeal as RouteSeal | undefined;

    expect(stampedRouteSeal).toMatchObject({
      route: "reply",
      turnId: stampedRouteSeal?.turnId,
      threadBindingKey: "slack:user:u-route-seal",
    });
    expect(policyState.get(ctx.sessionKey)?.routeSeal?.route).toBe("reply");
    expect((result?.decision.routeSeal as RouteSeal | undefined)?.route).toBe("reply");
  });

  it("detects sealed delegate route when freeform dispatch attempts reply override", () => {
    const routeSeal = seal({ route: "delegate" });
    const decision = {
      route_decision: { route: "delegate" },
      request: { metadata: { routeSeal } },
    };
    const validSeal = validCachedRouteSeal(
      { routeSeal },
      decision,
      { turn_id: "turn-1", session_key: "thread-1" },
    );

    expect(validSeal?.route).toBe("delegate");
    expect("reply").not.toBe(validSeal?.route);
  });
});
