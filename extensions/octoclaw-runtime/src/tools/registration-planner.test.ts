import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCoverageSnapshot, CoverageAuthority, WorkContract } from "@octoclaw/contracts/work-contract";
import { envOverrides } from "../resolve/env.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { saveWorkContract } from "../work-contract/store.js";
import { getToolRegistrations } from "./registration.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

const ENV_KEYS = ["OCTOCLAW_SPAWN_BACKEND", "OCTOCLAW_SPAWN_INTENT_TTL_MS", "OCTOCLAW_RUNTIME_LEDGER", "OCTOCLAW_SCHEDULER_ENABLED"] as const;
let originalEnv: typeof process.env;
let tempWorkspace = "";

vi.setConfig({ testTimeout: 30_000 });

function dispatchTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch not registered");
  return tool;
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

function seedWorkContract(): WorkContract {
  const contract = buildWorkContractFromPolicy(
    "session-planner-dispatch",
    "Research OpenClaw sessions_spawn planner behavior and summarize implementation risks.",
    "fresh_live_lookup",
    buildCoverageSnapshot(),
    buildWorkDecisionSeal("local_judge", "delegate", ["planner_dispatch_test"]),
    { status: "sealed" },
  );
  saveWorkContract(contract);
  return contract;
}

function delegateDecision(contract: WorkContract) {
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
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
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
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
    expect(countRows("scheduler_queue", "work_contract_id = ?", [contract.workContractId])).toBe(0);
    expect(countRows("task_attempts", "work_contract_id = ?", [contract.workContractId])).toBe(0);
  });
});
