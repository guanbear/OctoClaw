import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { envOverrides } from "../resolve/env.js";
import { policyState } from "../state/policy-state.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { saveWorkContract } from "../work-contract/store.js";
import { getToolRegistrations } from "./registration.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

const ENV_KEYS = ["OCTOCLAW_SPAWN_BACKEND", "OCTOCLAW_PLANNER_ALLOWLIST", "OCTOCLAW_SPAWN_INTENT_TTL_MS", "OCTOCLAW_RUNTIME_LEDGER", "OCTOCLAW_SCHEDULER_ENABLED"];
let originalEnv: Record<string, string | undefined>;
let tempWorkspace = "";

vi.setConfig({ testTimeout: 30_000 });

function dispatchTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch not registered");
  return tool;
}

function confirmTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch_confirm");
  if (!tool) throw new Error("octoclaw_dispatch_confirm not registered");
  return tool;
}

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

function seedWorkContract() {
  const contract = buildWorkContractFromPolicy(
    "session-planner-dispatch",
    "Research OpenClaw sessions_spawn planner behavior and summarize implementation risks.",
    "fresh_live_lookup",
    coverageSnapshot(),
    buildWorkDecisionSeal("local_judge", "delegate", ["planner_dispatch_test"]),
    { status: "sealed" },
  );
  saveWorkContract(contract);
  return contract;
}

function delegateDecision(contract: ReturnType<typeof seedWorkContract>) {
  return {
    request: { session_key: contract.sessionKey },
    route_decision: {
      route: "delegate",
      worker_pool: "octoclaw-research",
      task_class: "worker_research",
      expected_deliverable: "A compact implementation risk summary.",
    },
    model_policy: { selected_model: "worker_research" },
    is_new_work: true,
    expected_deliverable: "A compact implementation risk summary.",
    workContractId: contract.workContractId,
  };
}

function countRows(table: string, where = "1=1", params: unknown[] = []): number {
  const opened = openRuntimeLedger({ mode: "best_effort" });
  if (opened.status !== "ok" || !opened.db) return 0;
  try {
    const row = opened.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params);
    return Number(row?.count ?? 0);
  } finally {
    opened.db.close();
  }
}

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-registration-planner-"));
  envOverrides.workspaceRoot = tempWorkspace;
  nativeSpawnIntentStore.clearForTests();
  for (const { key } of policyState.entries()) policyState.clear(key);
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  for (const { key } of policyState.entries()) policyState.clear(key);
  envOverrides.workspaceRoot = "";
  process.env = originalEnv;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("octoclaw_dispatch planner backend", () => {
  it("returns a native sessions_spawn plan without legacy scheduler side effects", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    const contract = seedWorkContract();

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-dispatch-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    expect(body.nextTool).toBe("sessions_spawn");
    expect(body.confirmTool).toBe("octoclaw_dispatch_confirm");
    expect(body.dispatch_executed).toBe(false);
    expect(body.spawn_executed).toBe(false);
    expect(body.sessionsSpawnArgs).toMatchObject({
      runtime: "subagent",
      mode: "run",
      cleanup: "keep",
      lightContext: true,
      runTimeoutSeconds: 900,
    });
    expect(body.sessionsSpawnArgs.task).toContain(contract.workContractId);
    expect(JSON.stringify(body.sessionsSpawnArgs).length).toBeLessThan(2_500);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
    expect(countRows("scheduler_queue", "work_contract_id = ?", [contract.workContractId])).toBe(0);
    expect(countRows("task_attempts", "work_contract_id = ?", [contract.workContractId])).toBe(0);
    expect(countRows("completion_bindings", "work_contract_id = ?", [contract.workContractId])).toBe(0);
  });

  it("requires an explicit runId in accepted confirm results", async () => {
    const contract = seedWorkContract();
    const sessionsSpawnArgs = {
      task: "Confirm wrapper should not treat childRunId as runId.",
      runtime: "subagent" as const,
      mode: "run" as const,
      cleanup: "keep" as const,
      sandbox: "inherit" as const,
      lightContext: true,
    };
    const intent = nativeSpawnIntentStore.create({
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs,
      ttlMs: 60_000,
    });
    const started = nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs,
    });
    expect(started.ok).toBe(true);

    const response = await confirmTool().execute({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionsSpawnStatus: "accepted",
      sessionsSpawnResultJson: JSON.stringify({ status: "accepted", runId: "json-run-only", childRunId: "child-only" }),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-confirm-child-only",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.error).toBe("run_id_required");
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");

    const acceptedResponse = await confirmTool().execute({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionsSpawnStatus: "accepted",
      runId: "top-level-run",
      sessionsSpawnResultJson: JSON.stringify({ status: "accepted", runId: "json-run-ignored", childRunId: "child-from-json" }),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-confirm-explicit-run",
      cwd: tempWorkspace,
    });

    const accepted = JSON.parse(String(acceptedResponse.text));
    expect(accepted.ok).toBe(true);
    expect(accepted.runId).toBe("top-level-run");
    expect(accepted.childRunId).toBe("child-from-json");
  });

  it("rejects planner dispatch when admission dry-run does not issue a new-work ticket", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract();
    const decision = { ...delegateDecision(contract), is_new_work: false };

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(decision),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-dispatch-rejected-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("delegation_ticket_rejected:not_new_work");
    expect(body.dispatch_executed).toBe(false);
    expect(body.spawn_executed).toBe(false);
    expect(countRows("native_spawn_intents", "work_contract_id = ?", [contract.workContractId])).toBe(0);
    expect(countRows("scheduler_queue", "work_contract_id = ?", [contract.workContractId])).toBe(0);
  });

});
