import { describe, expect, it } from "vitest";

import { evaluateNativeSessionsSendHookGate, evaluateNativeSpawnHookGate } from "./native-spawn-gate-runner.js";

describe("NativeSpawnGate runner", () => {
  it("blocks sessions_spawn without a pending intent using the existing reason", () => {
    const result = evaluateNativeSpawnHookGate({
      toolName: "sessions_spawn",
      sessionKeys: ["session-no-intent"],
      args: { task: "implement" },
      decision: {},
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw blocked sessions_spawn because no current pending native spawn intent exists. Call octoclaw_dispatch first.",
      replayEvents: [expect.objectContaining({ event: "sessions_spawn_intent_blocked" })],
      statePatch: { blockedTools: ["sessions_spawn"] },
    });
  });

  it("does not handle non-spawn tools", () => {
    expect(evaluateNativeSpawnHookGate({
      toolName: "octoclaw_dispatch",
      sessionKeys: ["session"],
      args: { task: "implement" },
      decision: {},
    })).toEqual({ kind: "allow" });
  });

  it("blocks sessions_send without a speculative send intent using the existing reason", () => {
    const result = evaluateNativeSessionsSendHookGate({
      toolName: "sessions_send",
      sessionKeys: ["session-no-send-intent"],
      args: { session: "child", message: "go" },
      decision: { route_decision: { route: "delegate" } },
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw blocked sessions_send because no current pending speculative send intent exists. Call octoclaw_dispatch first.",
      replayEvents: [expect.objectContaining({ event: "sessions_send_intent_blocked" })],
      statePatch: { blockedTools: ["sessions_send"] },
    });
  });
});
