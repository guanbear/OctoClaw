import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextCoverageSnapshot, CoverageAuthority, WorkContract } from "@octoclaw/contracts/work-contract";
import { envOverrides } from "../resolve/env.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { evaluateNativeSpawnGate } from "./native-spawn-gate.js";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";
import { confirmNativeSpawn } from "./native-spawn-confirm.js";
import type { SessionsSpawnArgs } from "./native-spawn-intent.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

let tempWorkspace = "";

function useTempWorkspace(): string {
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-native-spawn-intent-"));
  envOverrides.workspaceRoot = tempWorkspace;
  return tempWorkspace;
}

function buildCoverageSnapshot(): ContextCoverageSnapshot {
  const execution = buildExecutionCoverageLayer(["missing"]);
  const memory = buildMemoryCoverageLayer();
  const hasConflict = Boolean(execution.coverage !== "none" && memory.coverage !== "none");
  const authority: CoverageAuthority = hasConflict
    ? "execution_wins"
    : execution.coverage !== "none"
      ? "execution_wins"
      : memory.coverage !== "none"
        ? "memory_only"
        : "none";
  return {
    precheckOrder: ["conversation_grounding", "continuation_route_reuse", "execution_coverage", "memory_coverage", "build_judge_context_packet", "local_judge", "validator_or_remote", "route_seal_commit"],
    execution,
    memory,
    conflict: hasConflict,
    authority,
  };
}

function seedWorkContract(sessionKey = "session-native-spawn-confirm"): WorkContract {
  const contract = buildWorkContractFromPolicy(
    sessionKey,
    "Research the planner confirm handshake and summarize it.",
    "fresh_live_lookup",
    buildCoverageSnapshot(),
    buildWorkDecisionSeal("local_judge", "delegate", ["native_spawn_test"]),
    { status: "sealed" },
  );
  saveWorkContract(contract);
  return contract;
}

function spawnArgs(task = "Do the delegated work"): SessionsSpawnArgs {
  return {
    task,
    label: "delegated work",
    runtime: "subagent",
    model: "zhipu/GLM-5.1",
    mode: "run",
    cleanup: "keep",
    sandbox: "inherit",
    lightContext: true,
  };
}

beforeEach(() => {
  useTempWorkspace();
  nativeSpawnIntentStore.clearForTests();
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  envOverrides.workspaceRoot = "";
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("NativeSpawnIntent store and gate", () => {
  it("allows sessions_spawn only for a matching pending intent", () => {
    const args = spawnArgs();
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-gate",
      delegateTaskId: "delegate-wc-gate",
      attemptId: "delegate-wc-gate:attempt:1",
      sessionKey: "session-gate",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const allowed = evaluateNativeSpawnGate({ sessionKeys: ["session-gate"], args });
    expect(allowed.allowed).toBe(true);
    expect(allowed.allowed ? allowed.intent.spawnIntentId : "").toBe(intent.spawnIntentId);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
  });

  it("allows OpenClaw-enriched sessions_spawn args that are equivalent to the planner args", () => {
    const args = spawnArgs();
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-gate-normalized",
      delegateTaskId: "delegate-wc-gate-normalized",
      attemptId: "delegate-wc-gate-normalized:attempt:1",
      sessionKey: "session-gate-normalized",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const allowed = evaluateNativeSpawnGate({
      sessionKeys: ["session-gate-normalized"],
      args: {
        ...args,
        agentId: "",
        thinking: "",
        timeoutSeconds: 0,
        thread: false,
        attachments: [],
        attachAs: { mountPath: "" },
      },
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.allowed ? allowed.intent.spawnIntentId : "").toBe(intent.spawnIntentId);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
  });

  it("blocks sessions_spawn when args differ from the planned hash", () => {
    nativeSpawnIntentStore.create({
      workContractId: "wc-mismatch",
      sessionKey: "session-mismatch",
      sessionsSpawnArgs: spawnArgs("original task"),
      ttlMs: 60_000,
    });

    const blocked = evaluateNativeSpawnGate({ sessionKeys: ["session-mismatch"], args: spawnArgs("changed task") });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("args_hash_mismatch");
  });

  it("blocks expired intents", () => {
    nativeSpawnIntentStore.create({
      workContractId: "wc-expired",
      sessionKey: "session-expired",
      sessionsSpawnArgs: spawnArgs(),
      ttlMs: 10,
      now: new Date("2026-05-02T00:00:00.000Z"),
    });

    const blocked = evaluateNativeSpawnGate({
      sessionKeys: ["session-expired"],
      args: spawnArgs(),
      now: new Date("2026-05-02T00:00:01.000Z"),
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("missing_pending_intent");
  });

  it("blocks execution follow-up spawn even with a matching intent", () => {
    const args = spawnArgs();
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-followup-block",
      sessionKey: "session-followup-block",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const blocked = evaluateNativeSpawnGate({
      sessionKeys: ["session-followup-block"],
      args,
      decision: { request: { metadata: { conversation_control: { intent_class: "execution_followup" } } } },
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("execution_followup_spawn_blocked");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("planned");
  });
});

describe("confirmNativeSpawn", () => {
  it("requires runId for accepted native spawn", async () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-confirm-missing-run",
      sessionKey: "session-confirm-missing-run",
      sessionsSpawnArgs: spawnArgs(),
      ttlMs: 60_000,
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: intent.workContractId,
      sessionKey: intent.sessionKey,
      sessionsSpawnStatus: "accepted",
      notify: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("run_id_required");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("planned");
  });


  it("rejects accepted confirm before sessions_spawn gate starts the intent", async () => {
    const contract = seedWorkContract("session-confirm-bypass");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: spawnArgs(),
      ttlMs: 60_000,
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-bypass",
      notify: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_status:planned");
    expect(loadWorkContract(contract.workContractId)?.delegate?.nativeBinding ?? null).toBeNull();
  });

  it("records native refs after accepted confirm without advancing WorkContract status", async () => {
    const contract = seedWorkContract();
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      attemptId: `delegate-task:${contract.workContractId}:attempt:1`,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: spawnArgs(),
      ttlMs: 60_000,
    });

    nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: spawnArgs(),
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-confirmed",
      childSessionKey: "child-session-confirmed",
      notify: false,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("accepted");
    const accepted = nativeSpawnIntentStore.get(intent.spawnIntentId);
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.runId).toBe("run-confirmed");
    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.status).toBe("sealed");
    expect(reloaded?.delegate?.nativeBinding?.runId).toBe("run-confirmed");
    expect(reloaded?.continuity.preferredChildSessionKey).toBe("child-session-confirmed");
  });

  it("is idempotent for the same runId and conflicts for a different runId", async () => {
    const contract = seedWorkContract("session-confirm-idempotent");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: spawnArgs(),
      ttlMs: 60_000,
    });

    nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: spawnArgs(),
    });

    const first = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-1",
      notify: false,
    });
    const second = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-1",
      notify: false,
    });
    const conflict = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-2",
      notify: false,
    });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("idempotent");
    expect(conflict.status).toBe("conflict");
  });
});
