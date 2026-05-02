import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { envOverrides } from "../resolve/env.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { confirmNativeSpawn } from "./native-spawn-confirm.js";
import { evaluateNativeSpawnGate } from "./native-spawn-gate.js";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";
import type { SessionsSpawnArgs } from "./native-spawn-intent.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

let tempWorkspace = "";

const args: SessionsSpawnArgs = {
  task: "Research the native planner confirm handshake.",
  label: "planner confirm",
  runtime: "subagent",
  model: "zhipu/GLM-5.1",
  mode: "run",
  cleanup: "keep",
  sandbox: "inherit",
  lightContext: true,
};

function coverageSnapshot(): ContextCoverageSnapshot {
  const execution = buildExecutionCoverageLayer(["missing"]);
  const memory = buildMemoryCoverageLayer();
  return {
    precheckOrder: [
      "conversation_grounding",
      "continuation_route_reuse",
      "execution_coverage",
      "memory_coverage",
      "build_judge_context_packet",
      "local_judge",
      "validator_or_remote",
      "route_seal_commit",
    ],
    execution,
    memory,
    conflict: false,
    authority: "none" as const,
  };
}

function seedContract(sessionKey = "session-native-spawn-confirm") {
  const contract = buildWorkContractFromPolicy(
    sessionKey,
    "Research the planner confirm handshake and summarize it.",
    "fresh_live_lookup",
    coverageSnapshot(),
    buildWorkDecisionSeal("local_judge", "delegate", ["native_spawn_test"]),
    { status: "sealed" },
  );
  saveWorkContract(contract);
  return contract;
}

beforeEach(() => {
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-native-spawn-gate-confirm-"));
  envOverrides.workspaceRoot = tempWorkspace;
  nativeSpawnIntentStore.clearForTests();
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  envOverrides.workspaceRoot = "";
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("evaluateNativeSpawnGate", () => {
  it("allows matching sessions_spawn args and moves intent to spawn_call_started", () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-gate",
      sessionKey: "session-gate",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const allowed = evaluateNativeSpawnGate({ sessionKeys: ["session-gate"], args });

    expect(allowed.allowed).toBe(true);
    expect(allowed.allowed ? allowed.intent.spawnIntentId : "").toBe(intent.spawnIntentId);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
  });

  it("normalizes OpenClaw default/enriched args without weakening meaningful fields", () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-normalized",
      sessionKey: "session-normalized",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const allowed = evaluateNativeSpawnGate({
      sessionKeys: ["session-normalized"],
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
  });

  it("blocks expired pending intent and marks it expired", () => {
    const createdAt = new Date("2026-05-02T12:00:00.000Z");
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-expired",
      sessionKey: "session-expired",
      sessionsSpawnArgs: args,
      ttlMs: 50,
      now: createdAt,
    });

    const blocked = evaluateNativeSpawnGate({
      sessionKeys: ["session-expired"],
      args,
      now: new Date(createdAt.getTime() + 51),
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("missing_pending_intent");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("expired");
  });

  it("blocks hash mismatch and execution follow-up spawns", () => {
    nativeSpawnIntentStore.create({
      workContractId: "wc-mismatch",
      sessionKey: "session-mismatch",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const mismatch = evaluateNativeSpawnGate({ sessionKeys: ["session-mismatch"], args: { ...args, task: "changed" } });
    expect(mismatch.allowed).toBe(false);
    expect(mismatch.reason).toBe("args_hash_mismatch");

    const followup = evaluateNativeSpawnGate({
      sessionKeys: ["session-mismatch"],
      args,
      decision: { request: { metadata: { conversation_control: { intent_class: "execution_followup" } } } },
    });
    expect(followup.allowed).toBe(false);
    expect(followup.reason).toBe("execution_followup_spawn_blocked");
  });
});

describe("confirmNativeSpawn", () => {
  it("requires runId and refuses planned -> accepted", async () => {
    const contract = seedContract("session-confirm-planned");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const missingRun = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      notify: false,
    });
    expect(missingRun.ok).toBe(false);
    expect(missingRun.error).toBe("run_id_required");

    const bypass = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-bypass",
      notify: false,
    });
    expect(bypass.ok).toBe(false);
    expect(bypass.error).toBe("invalid_status:planned");
    expect(loadWorkContract(contract.workContractId)?.delegate?.nativeBinding ?? null).toBeNull();
  });

  it("records native refs only after gate moved intent to spawn_call_started", async () => {
    const contract = seedContract();
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      attemptId: `delegate-task:${contract.workContractId}:attempt:1`,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    const gate = evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args });
    expect(gate.allowed).toBe(true);

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
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("accepted");
    const updated = loadWorkContract(contract.workContractId);
    expect(updated?.status).toBe("sealed");
    expect(updated?.telemetry.dispatchExecuted).toBe(true);
    expect(updated?.telemetry.spawnExecuted).toBe(true);
    expect(updated?.delegate?.nativeBinding?.runId).toBe("run-confirmed");
    expect(updated?.delegate?.nativeBinding?.childSessionKey).toBe("child-session-confirmed");
  });

  it("marks failed native spawn results without recording refs", async () => {
    const contract = seedContract("session-confirm-failed");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    const gate = evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args });
    expect(gate.allowed).toBe(true);

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "error",
      error: "native rejected spawn",
      notify: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("failed");
    expect(loadWorkContract(contract.workContractId)?.delegate?.nativeBinding ?? null).toBeNull();
  });

  it("treats same-run confirm as idempotent and different-run confirm as conflict", async () => {
    const contract = seedContract("session-confirm-idempotent");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);

    const first = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-once",
      childSessionKey: "child-once",
      notify: false,
    });
    const second = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-once",
      childSessionKey: "child-once",
      notify: false,
    });
    const conflict = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-different",
      notify: false,
    });

    expect(first.status).toBe("accepted");
    expect(second.ok).toBe(true);
    expect(second.status).toBe("idempotent");
    expect(conflict.ok).toBe(false);
    expect(conflict.status).toBe("conflict");
    expect(loadWorkContract(contract.workContractId)?.delegate?.nativeBinding?.runId).toBe("run-once");
  });

  it("marks ACK only after accepted confirm evidence", async () => {
    const contract = seedContract("session-confirm-ack-order");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const plannedConfirm = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-too-early",
    });
    expect(plannedConfirm.ok).toBe(false);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();

    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);
    const accepted = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-ack-after-accepted",
    });

    expect(accepted.ok).toBe(true);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt).toBeTruthy();
  });

});
