import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { resetAllState as resetAckDedupeState } from "../ack/ack-dedupe.js";
import { resetExecTransitionState } from "../ack/execution-transition-notifier.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { envOverrides } from "../resolve/env.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract, updateWorkContract } from "../work-contract/store.js";
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
let previousLegacyCliDelivery: string | undefined;

const args: SessionsSpawnArgs = {
  task: "Research the native planner confirm handshake.",
  label: "planner confirm",
  runtime: "subagent",
  model: "zhipu/GLM-5.1",
  mode: "run",
  cleanup: "keep",
  sandbox: "inherit",
  context: "isolated",
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
  previousLegacyCliDelivery = process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
  process.env.OCTOCLAW_LEGACY_CLI_DELIVERY = "1";
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-native-spawn-gate-confirm-"));
  envOverrides.workspaceRoot = tempWorkspace;
  nativeSpawnIntentStore.clearForTests();
  resetAckDedupeState();
  resetExecTransitionState();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAckDedupeState();
  resetExecTransitionState();
  nativeSpawnIntentStore.clearForTests();
  envOverrides.workspaceRoot = "";
  if (previousLegacyCliDelivery === undefined) delete process.env.OCTOCLAW_LEGACY_CLI_DELIVERY;
  else process.env.OCTOCLAW_LEGACY_CLI_DELIVERY = previousLegacyCliDelivery;
  previousLegacyCliDelivery = undefined;
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

  it("blocks planner sessions_spawn args when the isolated context flag is missing", () => {
    nativeSpawnIntentStore.create({
      workContractId: "wc-context-isolated",
      sessionKey: "session-context-isolated",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const { context: _context, ...missingContext } = args;
    const blocked = evaluateNativeSpawnGate({
      sessionKeys: ["session-context-isolated"],
      args: missingContext,
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("args_hash_mismatch");
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

  it("checks every Slack session alias before blocking on a stale hash mismatch", () => {
    const staleSlackChannelKey = "agent:main:slack:channel:c0as4dappu3";
    const matchingSlackThreadKey = "agent:main:slack:channel:c0as4dappu3:thread:1777707495.459389";
    const staleIntent = nativeSpawnIntentStore.create({
      workContractId: "wc-stale-alias",
      sessionKey: staleSlackChannelKey,
      sessionsSpawnArgs: { ...args, task: "old stale planner args" },
      ttlMs: 60_000,
    });
    const matchingIntent = nativeSpawnIntentStore.create({
      workContractId: "wc-real-alias",
      sessionKey: matchingSlackThreadKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });

    const allowed = evaluateNativeSpawnGate({
      sessionKeys: [staleSlackChannelKey, matchingSlackThreadKey],
      args,
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.allowed ? allowed.intent.spawnIntentId : "").toBe(matchingIntent.spawnIntentId);
    expect(nativeSpawnIntentStore.get(staleIntent.spawnIntentId)?.status).toBe("planned");
    expect(nativeSpawnIntentStore.get(matchingIntent.spawnIntentId)?.status).toBe("spawn_call_started");
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

  it("fails closed when WorkContract native refs cannot be written", async () => {
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-missing-for-native-refs",
      sessionKey: "session-confirm-missing-contract",
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: ["session-confirm-missing-contract"], args }).allowed).toBe(true);

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc-missing-for-native-refs",
      sessionKey: "session-confirm-missing-contract",
      sessionsSpawnStatus: "accepted",
      runId: "run-no-contract",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("work_contract_native_refs_write_failed");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.runId ?? null).toBeNull();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();
  });

  it("fails closed when the intent store is unavailable during accepted confirm", async () => {
    const contract = seedContract("session-confirm-store-unavailable");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);
    const storeError = new Error("database is locked");
    (storeError as Error & { code?: string }).code = "SQLITE_BUSY";
    vi.spyOn(nativeSpawnIntentStore, "get").mockImplementationOnce(() => {
      throw storeError;
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-store-busy",
      childSessionKey: "child-store-busy",
      notify: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toBe("sqlite_busy");
    expect(loadWorkContract(contract.workContractId)?.nativeSpawnRefs?.openclawRunId ?? null).toBeNull();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
  });

  it("rolls back WorkContract native refs when accepted intent transition fails after refs write", async () => {
    const contract = seedContract("session-confirm-transition-fails");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);
    const startedIntent = nativeSpawnIntentStore.get(intent.spawnIntentId);
    expect(startedIntent?.status).toBe("spawn_call_started");
    vi.spyOn(nativeSpawnIntentStore, "confirmAccepted").mockImplementationOnce(() => {
      updateWorkContract(contract.workContractId, (current) => ({
        ...current,
        mainContext: {
          ...current.mainContext,
          statusLine: "concurrent status update survives rollback",
        },
      }));
      return {
        ok: false,
        status: "error",
        intent: startedIntent ? { ...startedIntent, status: "expired" as const } : undefined,
        error: "intent_expired",
      };
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-transition-fails",
      childSessionKey: "child-transition-fails",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("intent_expired");
    const restored = loadWorkContract(contract.workContractId);
    expect(restored?.nativeSpawnRefs?.openclawRunId ?? null).toBeNull();
    expect(restored?.delegate?.nativeBinding ?? null).toBeNull();
    expect(restored?.telemetry.dispatchExecuted ?? false).toBe(false);
    expect(restored?.telemetry.spawnExecuted ?? false).toBe(false);
    expect(restored?.mainContext.statusLine).toBe("concurrent status update survives rollback");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();
  });

  it("does not rollback over native refs written by a successful racing confirm", async () => {
    const contract = seedContract("session-confirm-race-rollback");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);
    const startedIntent = nativeSpawnIntentStore.get(intent.spawnIntentId);
    expect(startedIntent?.status).toBe("spawn_call_started");
    vi.spyOn(nativeSpawnIntentStore, "confirmAccepted").mockImplementationOnce(() => {
      updateWorkContract(contract.workContractId, (current) => {
        const nativeBinding = {
          ...(current.delegate?.nativeBinding ?? {}),
          flowId: "sessions_spawn:run-success-race",
          ownerKey: intent.delegateTaskId || contract.workContractId,
          controllerId: "octoclaw.delegate",
          revision: 1,
          expectedRevision: 1,
          runId: "run-success-race",
          childRunId: "run-success-race",
          childSessionKey: "child-success-race",
          syncMode: "managed" as const,
          status: "running" as const,
          lastMutation: "runTask" as const,
          lastMutationApplied: true,
        };
        return {
          ...current,
          delegate: current.delegate ? { ...current.delegate, nativeBinding } : current.delegate,
          nativeSpawnRefs: {
            ...current.nativeSpawnRefs,
            openclawRunId: "run-success-race",
            childSessionKey: "child-success-race",
            requesterSessionKey: current.sessionKey,
            spawnIntentId: intent.spawnIntentId,
            spawnBackend: "sessions_spawn_planner",
            spawnMode: "run",
          },
          continuity: {
            ...current.continuity,
            preferredChildSessionKey: "child-success-race",
            preferredRunId: "run-success-race",
          },
          telemetry: {
            ...current.telemetry,
            dispatchExecuted: true,
            spawnExecuted: true,
            childSessionKey: "child-success-race",
            childRunId: "run-success-race",
          },
          mainContext: {
            ...current.mainContext,
            visibleIds: {
              ...current.mainContext.visibleIds,
              childSessionKey: "child-success-race",
              openclawRunId: "run-success-race",
              spawnIntentId: intent.spawnIntentId,
            },
          },
        };
      });
      return {
        ok: false,
        status: "conflict",
        intent: startedIntent ? { ...startedIntent, status: "accepted" as const, runId: "run-success-race" } : undefined,
        error: "run_id_conflict",
        existingRunId: "run-success-race",
      };
    });

    const result = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-loser-race",
      childSessionKey: "child-loser-race",
      notify: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("conflict");
    expect(result.error).toBe("run_id_conflict");
    const updated = loadWorkContract(contract.workContractId);
    expect(updated?.nativeSpawnRefs?.openclawRunId).toBe("run-success-race");
    expect(updated?.nativeSpawnRefs?.childSessionKey).toBe("child-success-race");
    expect(updated?.delegate?.nativeBinding?.runId).toBe("run-success-race");
    expect(updated?.telemetry.spawnExecuted).toBe(true);
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
      childSessionKey: "child-spoofed",
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
    expect(loadWorkContract(contract.workContractId)?.delegate?.nativeBinding?.childSessionKey).toBe("child-once");
  });

  it("retries ACK on idempotent same-run confirm when the first accepted confirm skipped notification", async () => {
    const envModule = await import("../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true, ts: "1777712000.000100" }),
      stderr: "",
      timedOut: false,
    });
    vi.spyOn(await import("../replay/replay.js"), "recordPolicyReplay").mockResolvedValue(undefined);

    const contract = seedContract("slack:channel:C1");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      attemptId: `delegate-task:${contract.workContractId}:attempt:1`,
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
      runId: "run-retry-ack",
      childSessionKey: "child-retry-ack",
      notify: false,
    });
    expect(first.ok).toBe(true);
    expect(first.status).toBe("accepted");
    expect(first.ackSent).toBe(false);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();
    expect(runCommandSpy).not.toHaveBeenCalled();

    const retry = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      stateKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-retry-ack",
      childSessionKey: "child-retry-ack",
      replyToMessageId: "1700000000.000100",
    });

    expect(retry.ok).toBe(true);
    expect(retry.status).toBe("idempotent");
    expect(retry.ackSent).toBe(true);
    expect(runCommandSpy).toHaveBeenCalledOnce();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).not.toBeNull();
  });

  it("does not mark ACK on failed notification and allows an idempotent retry to send it", async () => {
    const envModule = await import("../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand")
      .mockResolvedValueOnce({
        code: 1,
        stdout: JSON.stringify({ ok: false, error: "timeout" }),
        stderr: "timeout",
        timedOut: true,
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ ok: true, ts: "1777712001.000100" }),
        stderr: "",
        timedOut: false,
      });
    vi.spyOn(await import("../replay/replay.js"), "recordPolicyReplay").mockResolvedValue(undefined);

    const contract = seedContract("slack:channel:C2");
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      attemptId: `delegate-task:${contract.workContractId}:attempt:1`,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    expect(evaluateNativeSpawnGate({ sessionKeys: [contract.sessionKey], args }).allowed).toBe(true);

    const first = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      stateKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-ack-fails-once",
      childSessionKey: "child-ack-fails-once",
      replyToMessageId: "1700000000.000200",
    });

    expect(first.ok).toBe(true);
    expect(first.status).toBe("accepted");
    expect(first.ackSent).toBe(false);
    expect(first.ackSkipped).toBe(false);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();

    const retry = await confirmNativeSpawn({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      stateKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-ack-fails-once",
      childSessionKey: "child-ack-fails-once",
      replyToMessageId: "1700000000.000200",
    });

    expect(retry.ok).toBe(true);
    expect(retry.status).toBe("idempotent");
    expect(retry.ackSent).toBe(true);
    expect(runCommandSpy).toHaveBeenCalledTimes(2);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).not.toBeNull();
  });

  it("does not mark ACK until accepted confirm notification is sent or acceptably skipped", async () => {
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
    expect(accepted.ackSent).toBe(false);
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.ackSentAt ?? null).toBeNull();
  });

});
