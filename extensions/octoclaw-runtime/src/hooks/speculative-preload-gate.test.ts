import { describe, expect, it } from "vitest";

import { buildSpeculativePreloadSpawnArgs, speculativePreloadStateForHint } from "../delegate/speculative-preload.js";
import { evaluateSpeculativePreloadDispatchGate, evaluateSpeculativePreloadSpawnGate } from "./speculative-preload-gate.js";

describe("SpeculativePreloadGate", () => {
  const spawnArgs = {
    task: "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
    label: "octoclaw-speculative-test",
    runtime: "subagent",
    mode: "session",
    thread: true,
    cleanup: "keep",
    sandbox: "inherit",
    context: "isolated",
    lightContext: true,
    expectsCompletionMessage: false,
  };

  it("does not emit native per-call timeout fields for standby sessions_spawn args", () => {
    const args = buildSpeculativePreloadSpawnArgs({
      label: "octoclaw-speculative-test",
      runTimeoutSeconds: 300,
    });

    expect(args.runTimeoutSeconds).toBeUndefined();
    expect(args.timeoutSeconds).toBeUndefined();
  });

  it("blocks octoclaw_dispatch with exact standby spawn instructions when a matching hint is active", () => {
    const result = evaluateSpeculativePreloadDispatchGate({
      toolName: "octoclaw_dispatch",
      decision: { route_decision: { route: "delegate" } },
      stateKey: "session-1",
      state: {
        workContractId: "wc-1",
        speculativePreload: speculativePreloadStateForHint({ label: "octoclaw-speculative-test", spawnArgs }),
      },
      ctx: { sessionId: "runtime-session-1" },
      statesByKey: new Map(),
      expectedWorkContractId: "wc-1",
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      replayEvents: [expect.objectContaining({ event: "speculative_preload_dispatch_deferred" })],
    });
    expect(result.kind).toBe("block");
    if (result.kind !== "block") throw new Error("expected speculative dispatch gate to block");
    expect(result.blockReason).toContain("First call sessions_spawn exactly");
    expect(result.blockReason).toContain(JSON.stringify(spawnArgs));
  });

  it("marks matching standby spawn hints as started and emits one replay event", () => {
    const state = {
      speculativePreload: speculativePreloadStateForHint({ label: "octoclaw-speculative-test", spawnArgs }),
    };
    const result = evaluateSpeculativePreloadSpawnGate({
      toolName: "sessions_spawn",
      toolParams: spawnArgs,
      decision: { request: { session_key: "session-1" }, route_decision: { route: "delegate" } },
      stateKey: "session-1",
      state,
      ctx: { sessionId: "runtime-session-1" },
      statesByKey: new Map([["session-1", state]]),
      sessionKeys: ["session-1"],
      now: 1234,
    });

    expect(result).toMatchObject({
      kind: "observe",
      statePatchesByKey: {
        "session-1": {
          speculativePreload: expect.objectContaining({ status: "spawn_call_started", updatedAt: 1234 }),
          speculative_preload: expect.objectContaining({ status: "spawn_call_started", updatedAt: 1234 }),
        },
      },
      replayEvents: [expect.objectContaining({ event: "speculative_preload_spawn_allowed" })],
    });
  });
});
