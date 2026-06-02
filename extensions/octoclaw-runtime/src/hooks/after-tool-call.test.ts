import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { envOverrides } from "../resolve/env.js";
import { policyState } from "../state/policy-state.js";
import { makeAfterToolCallHook } from "./after-tool-call.js";

const mockConfirmNativeSpawn = vi.hoisted(() => vi.fn());

vi.mock("../delegate/native-spawn-confirm.js", () => ({
  confirmNativeSpawn: mockConfirmNativeSpawn,
}));

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

let tempWorkspace = "";
let originalRuntimeDbPath: string | undefined;
let originalWorkspaceEnv: string | undefined;

describe("after_tool_call native sessions_spawn auto-confirm", () => {
  beforeEach(() => {
    originalRuntimeDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
    originalWorkspaceEnv = process.env.WORKSPACE;
    tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-after-tool-call-"));
    envOverrides.workspaceRoot = tempWorkspace;
    process.env.WORKSPACE = tempWorkspace;
    process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tempWorkspace, ".octoclaw", "runtime", "octoclaw-runtime.sqlite");
    nativeSpawnIntentStore.clearForTests();
    mockConfirmNativeSpawn.mockReset();
    mockConfirmNativeSpawn.mockResolvedValue({
      ok: true,
      status: "accepted",
      spawnIntentId: "spawn-intent",
      workContractId: "wc-auto-confirm",
      runId: "run-auto-confirm",
      childRunId: "child-run-auto-confirm",
      childSessionKey: "agent:main:subagent:auto-confirm",
    });
  });

  afterEach(() => {
    nativeSpawnIntentStore.clearForTests();
    for (const entry of policyState.entries()) {
      policyState.clear(entry.key);
    }
    envOverrides.workspaceRoot = "";
    if (originalRuntimeDbPath === undefined) delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
    else process.env.OCTOCLAW_RUNTIME_DB_PATH = originalRuntimeDbPath;
    if (originalWorkspaceEnv === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = originalWorkspaceEnv;
    originalRuntimeDbPath = undefined;
    originalWorkspaceEnv = undefined;
    if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = "";
  });

  it("passes immutable delivery target anchor into automatic native spawn confirmation", async () => {
    const sessionKey = "agent:main:slack:channel:c0as4dappu3";
    const replyToMessageId = "1777709667.918049";
    const spawnArgs = {
      task: "Review OctoClaw routing changes for delegate regressions.",
      label: "route-review",
      runtime: "subagent" as const,
      model: "zhipu/GLM-5.1",
      mode: "run" as const,
    };
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-auto-confirm",
      delegateTaskId: "delegate-task:wc-auto-confirm",
      attemptId: "delegate-task:wc-auto-confirm:attempt:1",
      sessionKey,
      sessionsSpawnArgs: spawnArgs,
      dispatchMode: "new_spawn",
      ttlMs: 60_000,
    });
    nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey,
      sessionsSpawnArgs: spawnArgs,
      now: new Date("2026-06-02T08:00:00.000Z"),
    });
    policyState.setState(sessionKey, {
      decision: {
        route_decision: { route: "delegate" },
        request: { session_key: sessionKey },
      },
      deliveryTarget: {
        replyToMessageId,
        threadTs: replyToMessageId,
        immutable: true,
      },
      delivery_target: {
        replyToMessageId,
        threadTs: replyToMessageId,
        immutable: true,
      },
      spawnIntentId: intent.spawnIntentId,
      workContractId: intent.workContractId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const hook = makeAfterToolCallHook({
      pi: { logger: {} },
      currentPluginConfig: () => ({}),
    });

    await hook(
      {
        toolName: "sessions_spawn",
        params: spawnArgs,
        result: {
          status: "accepted",
          runId: "run-auto-confirm",
          childRunId: "child-run-auto-confirm",
          childSessionKey: "agent:main:subagent:auto-confirm",
          model: "zhipu/GLM-5.1",
        },
      },
      { sessionKey, sessionId: "session-auto-confirm", agentId: "main", cwd: tempWorkspace },
    );

    expect(mockConfirmNativeSpawn).toHaveBeenCalledWith(expect.objectContaining({
      spawnIntentId: intent.spawnIntentId,
      workContractId: intent.workContractId,
      sessionKey,
      replyToMessageId,
    }));
  });
});
