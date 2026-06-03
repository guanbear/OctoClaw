import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { envOverrides } from "../resolve/env.js";
import {
  evaluateNativeSessionsSendHookGate,
  evaluateNativeSessionsYieldHookGate,
  evaluateNativeSpawnHookGate,
} from "./native-spawn-gate-runner.js";

describe("NativeSpawnGate runner", () => {
  let tempWorkspace = "";

  beforeEach(() => {
    tempWorkspace = fsSync.mkdtempSync(path.join(os.tmpdir(), "octoclaw-native-spawn-runner-"));
    envOverrides.workspaceRoot = tempWorkspace;
    nativeSpawnIntentStore.clearForTests();
  });

  afterEach(() => {
    nativeSpawnIntentStore.clearForTests();
    envOverrides.workspaceRoot = "";
    if (tempWorkspace) fsSync.rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = "";
  });

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

  it("canonicalizes sessions_spawn args mismatch on the pending intent instead of blocking repeated guesses", () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-mismatch",
      sessionKey: "session-mismatch",
      sessionsSpawnArgs: { task: "canonical child task", label: "canonical" },
      ttlMs: 60_000,
      now: Date.now(),
    });

    const result = evaluateNativeSpawnHookGate({
      toolName: "sessions_spawn",
      sessionKeys: ["session-mismatch"],
      args: { task: "drifted child task\nworkContractId: wc-mismatch", label: "canonical" },
      decision: { route_decision: { route: "delegate" }, work_contract: { workContractId: "wc-mismatch" } },
      stateKey: "session-mismatch",
      sessionId: "runtime-session",
    });

    expect(result).toMatchObject({
      kind: "allow",
      params: { task: "canonical child task", label: "canonical" },
      replayEvents: [expect.objectContaining({
        event: "sessions_spawn_args_canonicalized",
        payload: expect.objectContaining({
          sessionKey: "session-mismatch",
          sessionId: "runtime-session",
          reason: "args_hash_mismatch_canonicalized",
          spawn_intent_id: intent.spawnIntentId,
          work_contract_id: "wc-mismatch",
        }),
      })],
    });
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
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
      decision: { route_decision: { route: "delegate" }, work_contract: { workContractId: "wc-send-mismatch" } },
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw blocked sessions_send because no current pending speculative send intent exists. Call octoclaw_dispatch first.",
      replayEvents: [expect.objectContaining({ event: "sessions_send_intent_blocked" })],
      statePatch: { blockedTools: ["sessions_send"] },
    });
  });

  it("canonicalizes sessions_send args mismatch on the pending speculative intent", () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-send-mismatch",
      sessionKey: "session-send-mismatch",
      sessionsSpawnArgs: { task: "canonical send task", message: "canonical message", label: "send" },
      dispatchMode: "send_to_speculative",
      ttlMs: 60_000,
      now: Date.now(),
    });

    const result = evaluateNativeSessionsSendHookGate({
      toolName: "sessions_send",
      sessionKeys: ["session-send-mismatch"],
      args: { task: "drifted send task", message: "drifted message for wc-send-mismatch", label: "send" },
      decision: { route_decision: { route: "delegate" }, work_contract: { workContractId: "wc-send-mismatch" } },
      stateKey: "session-send-mismatch",
      sessionId: "runtime-session",
    });

    expect(result).toMatchObject({
      kind: "allow",
      params: { task: "canonical send task", message: "canonical message", label: "send" },
      replayEvents: [expect.objectContaining({
        event: "sessions_send_args_canonicalized",
        payload: expect.objectContaining({
          sessionKey: "session-send-mismatch",
          sessionId: "runtime-session",
          reason: "args_hash_mismatch_canonicalized",
          spawn_intent_id: intent.spawnIntentId,
          work_contract_id: "wc-send-mismatch",
        }),
      })],
    });
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
  });

  it("blocks sessions_yield while a native child start is still pending", () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-yield",
      sessionKey: "session-yield",
      sessionsSpawnArgs: { task: "child task" },
      dispatchMode: "send_to_speculative",
      ttlMs: 60_000,
      now: Date.now(),
    });

    const result = evaluateNativeSessionsYieldHookGate({
      toolName: "sessions_yield",
      sessionKeys: ["session-yield"],
      decision: { route_decision: { route: "delegate" } },
      stateKey: "session-yield",
      sessionId: "runtime-session",
    });

    expect(result).toMatchObject({
      kind: "block",
      block: true,
      blockReason: expect.stringContaining("Call sessions_send exactly"),
      replayEvents: [expect.objectContaining({
        event: "sessions_yield_blocked_pending_native_spawn",
        payload: expect.objectContaining({
          spawn_intent_id: intent.spawnIntentId,
          dispatch_mode: "send_to_speculative",
        }),
      })],
      statePatch: { blockedTools: ["sessions_yield"] },
    });
  });
});
