import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { envOverrides } from "../resolve/env.js";
import { runNativeSessionToolGate } from "./native-session-tool-runner.js";

describe("NativeSessionTool runner", () => {
  let tempWorkspace = "";
  let originalSpawnBackend: string | undefined;
  let originalPlannerAllowlist: string | undefined;

  beforeEach(() => {
    originalSpawnBackend = process.env.OCTOCLAW_SPAWN_BACKEND;
    originalPlannerAllowlist = process.env.OCTOCLAW_PLANNER_ALLOWLIST;
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    delete process.env.OCTOCLAW_PLANNER_ALLOWLIST;
    tempWorkspace = fsSync.mkdtempSync(path.join(os.tmpdir(), "octoclaw-native-session-runner-"));
    envOverrides.workspaceRoot = tempWorkspace;
    nativeSpawnIntentStore.clearForTests();
  });

  afterEach(() => {
    if (originalSpawnBackend === undefined) delete process.env.OCTOCLAW_SPAWN_BACKEND;
    else process.env.OCTOCLAW_SPAWN_BACKEND = originalSpawnBackend;
    if (originalPlannerAllowlist === undefined) delete process.env.OCTOCLAW_PLANNER_ALLOWLIST;
    else process.env.OCTOCLAW_PLANNER_ALLOWLIST = originalPlannerAllowlist;
    nativeSpawnIntentStore.clearForTests();
    envOverrides.workspaceRoot = "";
    if (tempWorkspace) fsSync.rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = "";
  });

  it("handles an allowed sessions_send by recording spawn-start state and replay", async () => {
    const stateUpdates: Array<{ key: string; next: unknown }> = [];
    const replayEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const sendArgs = {
      task: "Run delegated task through standby session.",
      message: "Run delegated task through standby session.",
      label: "octoclaw-speculative-send",
      timeoutSeconds: 0,
    };
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-send-runner",
      sessionKey: "session-send-runner",
      sessionsSpawnArgs: sendArgs,
      dispatchMode: "send_to_speculative",
      speculativeSessionLabel: "octoclaw-speculative-send",
      ttlMs: 60_000,
      now: Date.now(),
    });

    const result = await runNativeSessionToolGate({
      toolName: "sessions_send",
      toolParams: sendArgs,
      decision: {
        request: { session_key: "session-send-runner" },
        route_decision: { route: "delegate", decision_bucket: "native_first" },
      },
      state: {},
      stateKey: "session-send-runner",
      ctx: { sessionId: "runtime-session", sessionKey: "session-send-runner" },
      currentPluginConfig: {},
      logger: {},
    }, {
      statesByKey: new Map(),
      updatePolicyState: (key, updater) => {
        const next = updater({});
        stateUpdates.push({ key, next });
      },
      updateBudgetedMainForContext: () => null,
      recordBudgetedMainEvent: async () => {},
      recordPolicyReplay: async (event, payload) => {
        replayEvents.push({ event, payload });
      },
      now: () => Date.now(),
    });

    expect(result.kind).toBe("handled");
    expect(stateUpdates).toEqual([{
      key: "session-send-runner",
      next: expect.objectContaining({
        delegated: false,
        spawnIntentId: intent.spawnIntentId,
        workContractId: "wc-send-runner",
        dispatchStatus: "spawn_call_started",
        controlToolsSeen: ["sessions_send"],
      }),
    }]);
    expect(replayEvents).toEqual([{
      event: "sessions_send_intent_allowed",
      payload: expect.objectContaining({
        sessionKey: "session-send-runner",
        sessionId: "runtime-session",
        route: "delegate",
        toolName: "sessions_send",
        spawn_intent_id: intent.spawnIntentId,
        work_contract_id: "wc-send-runner",
        dispatch_mode: "send_to_speculative",
        speculative_session_label: "octoclaw-speculative-send",
      }),
    }]);
  });
});
