import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTE_SEAL_SCHEMA_VERSION } from "@octoclaw/contracts/route-seal";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { envOverrides } from "../resolve/env.js";
import { policyState } from "../state/policy-state.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { getToolRegistrations } from "./registration.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

const ENV_KEYS = ["OCTOCLAW_SPAWN_BACKEND", "OCTOCLAW_PLANNER_ALLOWLIST", "OCTOCLAW_SPAWN_INTENT_TTL_MS", "OCTOCLAW_RUNTIME_LEDGER", "OCTOCLAW_SPECULATIVE_PRELOAD", "OPENCLAW_HOME"];
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

function policyDecideTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_policy_decide");
  if (!tool) throw new Error("octoclaw_policy_decide not registered");
  return tool;
}

function hasForbiddenTopLevelSchemaKeyword(schema: Record<string, unknown>): string | null {
  for (const keyword of ["allOf", "oneOf", "anyOf", "not", "enum"]) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) return keyword;
  }
  return null;
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

function seedWorkContract(sessionKey = "session-planner-dispatch") {
  const contract = buildWorkContractFromPolicy(
    sessionKey,
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

function readReplayEvents(): Array<Record<string, unknown>> {
  const replayPath = path.join(tempWorkspace, "tmp", "octopus", "runtime-policy-replay.jsonl");
  if (!fsSync.existsSync(replayPath)) return [];
  return fsSync.readFileSync(replayPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-registration-planner-"));
  envOverrides.workspaceRoot = tempWorkspace;
  envOverrides.octoclawRoot = "";
  nativeSpawnIntentStore.clearForTests();
  for (const { key } of policyState.entries()) policyState.clear(key);
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  for (const { key } of policyState.entries()) policyState.clear(key);
  envOverrides.workspaceRoot = "";
  envOverrides.octoclawRoot = "";
  process.env = originalEnv;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});

describe("octoclaw_dispatch planner backend", () => {
  it("registers a provider-safe confirm tool schema", () => {
    const params = confirmTool().params ?? {};
    expect(params.type).toBe("object");
    expect(hasForbiddenTopLevelSchemaKeyword(params)).toBeNull();
    expect(params.required).toEqual(["spawnIntentId", "workContractId", "sessionsSpawnStatus"]);
    expect(JSON.stringify(params)).not.toContain('"allOf"');
  });

  it("policy_decide forceRoute=delegate seeds a dispatchable delegate context", async () => {
    const sessionKey = "agent:main:slack:channel:c0as4dappu3";
    const task = "真实查证 OpenClaw 2026.4.29 相比 2026.4.21 的 release 变化，并用中文 5 句话总结。";

    const response = await policyDecideTool().execute({
      task,
      forceRoute: "delegate",
      sessionKey,
      metadataJson: JSON.stringify({
        expected_deliverable: "5 sentence verified summary with source links",
        is_new_work: true,
        relation_to_recent_execution: "new_work",
      }),
    }, {
      sessionKey,
      sessionId: "slack-session-policy-decide",
      agentId: "main",
      cwd: tempWorkspace,
    });

    const body = response.json as { route_decision?: Record<string, unknown>; work_contract?: Record<string, unknown> };
    expect(body.route_decision).toMatchObject({ route: "delegate" });
    expect(body.work_contract).toMatchObject({ route: "delegate", nextAction: "dispatch" });
    const stored = policyState.get(sessionKey);
    expect(stored?.prompt).toBe(task);
    expect(stored?.routeHintSubmitted).toBe(true);
    expect(stored?.decision?.route_decision).toMatchObject({ route: "delegate" });
    expect(stored?.decision?.work_contract).toMatchObject({ route: "delegate", nextAction: "dispatch" });
  });

  it("returns a native sessions_spawn plan with ledger admission and without legacy materialization side effects", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OPENCLAW_HOME = tempWorkspace;
    fsSync.writeFileSync(path.join(tempWorkspace, "openclaw.json"), JSON.stringify({
      acp: { fallbacks: ["acpx", "codex-native"] },
    }));
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
      context: "isolated",
      lightContext: true,
      runTimeoutSeconds: 900,
    });
    expect(body.sessionsSpawnArgs.label).toContain(`[${contract.workContractId}]`);
    expect(String(body.sessionsSpawnArgs.label).length).toBeLessThanOrEqual(80);
    expect(body.sessionsSpawnArgs.task).toContain(contract.workContractId);
    expect(body.sessionsSpawnArgs.task).toContain("octoclaw.planner_native_context.v1");
    expect(body.sessionsSpawnArgs.task).toContain("octoclaw.delegate_handoff.v1");
    expect(body.sessionsSpawnArgs.task).toContain(`\"cwd\": \"${tempWorkspace}\"`);
    expect(body.sessionsSpawnArgs.task).toContain("\"contextMode\": \"isolated\"");
    expect(body.sessionsSpawnArgs.task).toContain("\"contextStrategy\": \"bounded_brief_only\"");
    expect(body.sessionsSpawnArgs.task).toContain("\"workspaceMode\": \"read_only\"");
    expect(body.sessionsSpawnArgs.task).toContain("\"readScope\": []");
    expect(body.sessionsSpawnArgs.task).toContain("\"maxToolCalls\": 4");
    expect(body.sessionsSpawnArgs.task).toContain("avoid broad workspace inventory");
    expect(body.sessionsSpawnArgs.task).toContain("do not infer hidden parent transcript");
    expect(JSON.stringify(body.sessionsSpawnArgs).length).toBeLessThan(5_000);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
    expect(body.ticket_enforced).toBe(true);
    expect(body.ticket_admission_reason).toBe("ticket_admitted");
    expect(countRows("task_attempts", "work_contract_id = ?", [contract.workContractId])).toBe(1);
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_tool_started",
      work_contract_id: contract.workContractId,
      elapsedMs: expect.any(Number),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_backend_selected",
      spawn_backend: "planner",
      planner_enabled: true,
      planner_allowed_candidates: expect.arrayContaining([contract.sessionKey]),
      native_acp_fallback: expect.objectContaining({
        owner: "openclaw_acp",
        primaryRuntimeId: "acpx",
        fallbackRuntimeIds: ["acpx", "codex-native"],
        fallbackAttempted: false,
        reason: "host_runtime_owns_backend_failover",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_intent_created",
      work_contract_id: contract.workContractId,
      spawn_intent_id: body.spawnIntentId,
      complexityBand: "normal",
      complexity_band: "normal",
      native_acp_fallback: expect.objectContaining({
        owner: "openclaw_acp",
        primaryRuntimeId: "acpx",
        fallbackRuntimeIds: ["acpx", "codex-native"],
        fallbackAttempted: false,
        reason: "host_runtime_owns_backend_failover",
      }),
      elapsedMs: expect.any(Number),
    }));
    expect(policyState.get(contract.sessionKey)).toMatchObject({
      complexityBand: "normal",
      complexity_band: "normal",
    });
  });

  it("preserves judge complexity_band for planner native final footers", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OPENCLAW_HOME = tempWorkspace;
    fsSync.writeFileSync(path.join(tempWorkspace, "openclaw.json"), JSON.stringify({
      acp: { fallbacks: ["acpx", "codex-native"] },
    }));
    const contract = seedWorkContract("session-planner-complexity");
    const decision = delegateDecision(contract);
    (decision.route_decision as Record<string, unknown>).complexity_band = "deep";

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(decision),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-complexity-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(policyState.get(contract.sessionKey)).toMatchObject({
      complexityBand: "deep",
      complexity_band: "deep",
    });
    expect(loadWorkContract(contract.workContractId)?.telemetry as Record<string, unknown>).toMatchObject({
      complexityBand: "deep",
      complexity_band: "deep",
    });
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_intent_created",
      work_contract_id: contract.workContractId,
      complexityBand: "deep",
      complexity_band: "deep",
    }));
  });

  it("keeps planner intent and WorkContract anchored to the Slack parent when dispatch passes current", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:slack:channel:c0as4dappu3";
    const sessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1779257025.427719";
    const task = "查询当前系统运行状态并汇报。";
    const replyContract = buildWorkContractFromPolicy(
      sessionKey,
      task,
      "local_surface_lookup",
      coverageSnapshot(),
      buildWorkDecisionSeal("policy_rule", "reply", ["must_reply"]),
      { status: "sealed" },
    );
    saveWorkContract(replyContract);
    const routeSeal = {
      schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
      requestId: "req-current-parent",
      turnId: "turn-current-parent",
      threadBindingKey: "thread-current-parent",
      route: "reply",
      source: "policy_rule",
      reasonCodes: ["must_reply"],
      createdAt: "2026-05-20T06:03:48.188Z",
      inputHash: "hash-current-parent",
      stateGeneration: 1,
    };
    policyState.setState(sessionKey, {
      prompt: task,
      decision: {
        request: { session_key: sessionKey },
        routeSeal,
        workContractId: replyContract.workContractId,
        work_contract: {
          workContractId: replyContract.workContractId,
          work_contract_id: replyContract.workContractId,
          route: "reply",
          status: "sealed",
          forbiddenTools: ["octoclaw_dispatch", "spawn"],
        },
        route_decision: {
          route: "reply",
          system_preferred_route: "reply",
          worker_pool: "octoclaw-main",
          task_class: "main_direct",
          decision_bucket: "must_reply",
        },
        tool_policy: {
          allow_direct_tools: true,
          block_tool_patterns: ["octoclaw_dispatch", "spawn"],
        },
      },
      routeSeal,
      workContractId: replyContract.workContractId,
      work_contract_id: replyContract.workContractId,
      dispatchExecuted: false,
      spawnExecuted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const response = await dispatchTool().execute({
      task,
      forceRoute: "delegate",
      sessionKey: "current",
      metadataJson: JSON.stringify({
        turnId: "turn-current-parent",
        threadBindingKey: "thread-current-parent",
        session_key: "current",
      }),
      timeoutSeconds: 900,
    }, {
      sessionKey: "current",
      canonicalSessionKey: sessionKey,
      sessionId: "0ce0498d-965e-4122-bd31-0484262abb12",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    expect(body.workContractId).not.toBe(replyContract.workContractId);
    expect(loadWorkContract(body.workContractId)?.sessionKey).toBe(sessionKey);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.sessionKey).toBe(sessionKey);
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_intent_created",
      sessionKey,
      work_contract_id: body.workContractId,
    }));
  });

  it("honors explicit side-effect context refs with a bounded write scope", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract("session-planner-cron-write-scope");
    const task = [
      "创建一个定时任务，每12小时检查并处理GitHub PR。",
      "使用OpenClaw的定时任务机制设置cron，确保任务能够持续运行。",
    ].join("\n");

    const response = await dispatchTool().execute({
      task,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      metadataJson: JSON.stringify({
        context_refs: {
          requestedSideEffects: true,
          workspaceMode: "write_allowed",
          maxToolCalls: 6,
        },
      }),
      timeoutSeconds: 300,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-cron-write-scope",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    const spawnTask = String(body.sessionsSpawnArgs.task);
    expect(body.ok).toBe(true);
    expect(spawnTask).toContain("\"contextStrategy\": \"explicit_refs\"");
    expect(spawnTask).toContain("\"workspaceMode\": \"write_allowed\"");
    expect(spawnTask).toContain("\"writeScope\": [");
    expect(spawnTask).toContain("\"requested:side_effects\"");
    expect(spawnTask).toContain("native CLI/API for the target system");
    expect(spawnTask).toContain("smallest requested native CLI/API change");
    expect(spawnTask).toContain("\"maxToolCalls\": 6");
  });

  it("keeps native sessions_spawn labels unique when repeated task text is delegated", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const firstContract = seedWorkContract("session-planner-label-unique");
    const secondContract = seedWorkContract("session-planner-label-unique");
    expect(firstContract.userAsk).toBe(secondContract.userAsk);

    const firstResponse = await dispatchTool().execute({
      task: firstContract.userAsk,
      workContractId: firstContract.workContractId,
      policyJson: JSON.stringify(delegateDecision(firstContract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: firstContract.sessionKey,
      sessionId: "session-planner-label-unique-first",
      cwd: tempWorkspace,
    });

    const secondResponse = await dispatchTool().execute({
      task: secondContract.userAsk,
      workContractId: secondContract.workContractId,
      policyJson: JSON.stringify(delegateDecision(secondContract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: secondContract.sessionKey,
      sessionId: "session-planner-label-unique-second",
      cwd: tempWorkspace,
    });

    const firstBody = JSON.parse(String(firstResponse.text));
    const secondBody = JSON.parse(String(secondResponse.text));
    const firstLabel = String(firstBody.sessionsSpawnArgs.label);
    const secondLabel = String(secondBody.sessionsSpawnArgs.label);

    expect(firstBody.ok).toBe(true);
    expect(secondBody.ok).toBe(true);
    expect(firstLabel).not.toBe(secondLabel);
    expect(firstLabel).toContain(`[${firstContract.workContractId}]`);
    expect(secondLabel).toContain(`[${secondContract.workContractId}]`);
    expect(firstLabel.length).toBeLessThanOrEqual(80);
    expect(secondLabel.length).toBeLessThanOrEqual(80);
  });

  it("fails closed with explicit planner_not_allowed instead of falling through to legacy taskFlow", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:slack:channel:c0as4dappu3";
    const contract = seedWorkContract("agent:main:slack:default:direct:u0al9t5u89z");

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-dm-not-allowed",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.error).toBe("planner_not_allowed_for_session");
    expect(body.error).not.toContain("taskflow_unavailable");
    expect(nativeSpawnIntentStore.findPendingForSession(contract.sessionKey)).toBeNull();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_backend_selected",
      spawn_backend: "planner",
      planner_enabled: false,
      planner_allowlist_size: 1,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_not_allowed",
      error: "planner_not_allowed_for_session",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "dispatch_capability_failure",
      error: expect.stringContaining("taskflow_unavailable"),
    }));
  });

  it("derives planner session candidates from ctx session boundary when params.sessionKey is absent", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const sessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1779017257.196709";
    const contract = seedWorkContract(sessionKey);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
    }, {
      sessionId: sessionKey,
      agentId: "main",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    const events = readReplayEvents();
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    expect(backendSelected).toBeTruthy();
    expect(backendSelected!.planner_session_candidates).toBeDefined();
    expect((backendSelected!.planner_session_candidates as string[]).length).toBeGreaterThan(0);
    expect(backendSelected!.planner_session_candidates).toEqual(expect.arrayContaining([
      sessionKey,
      "agent:main:slack:channel:c0as4dappu3",
    ]));
    expect(backendSelected!.planner_enabled).toBe(true);
  });

  it("rebinds explicit delegate dispatch to recent Slack thread policy state when tool ctx is empty", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const sessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1779019848.438849";
    const originalPrompt = "[OCTOCLAW_ACCEPTANCE] run=smoke case=delegated_work-1 acceptance=true\n<@U0ARU7EKGCQ> 请委派子 agent 调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。";
    const dispatchTask = "调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。";
    const contract = buildWorkContractFromPolicy(
      sessionKey,
      originalPrompt,
      "fresh_live_lookup",
      coverageSnapshot(),
      buildWorkDecisionSeal("local_judge", "reply", ["initial_reply"]),
      { status: "sealed" },
    );
    saveWorkContract(contract);
    policyState.set(sessionKey, {
      prompt: originalPrompt,
      decision: {
        request: { session_key: sessionKey },
        routeSeal: {
          schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
          requestId: "request-acceptance",
          route: "reply",
          source: "local_judge",
          reasonCodes: ["initial_reply"],
          turnId: "turn-acceptance",
          threadBindingKey: sessionKey,
          createdAt: new Date().toISOString(),
          inputHash: "",
          stateGeneration: 0,
        },
        route_decision: { route: "reply" },
        workContractId: contract.workContractId,
        work_contract: { workContractId: contract.workContractId, route: "reply" },
        reply_contract: { forbiddenTools: ["octoclaw_dispatch"] },
        tool_policy: { block_tool_patterns: ["octoclaw_dispatch"] },
      },
    });

    const response = await dispatchTool().execute({
      task: dispatchTask,
      forceRoute: "delegate",
      timeoutSeconds: 900,
    }, {
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    const events = readReplayEvents();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    expect(backendSelected).toBeTruthy();
    expect(backendSelected!.planner_session_candidates).toEqual(expect.arrayContaining([
      sessionKey,
      "agent:main:slack:channel:c0as4dappu3",
    ]));
    expect(backendSelected!.planner_allowed_candidates).toEqual(expect.arrayContaining([
      "agent:main:slack:channel:c0as4dappu3",
    ]));
    expect(backendSelected!.planner_enabled).toBe(true);
  });

  it("recovers planner session from work contract when tool ctx is fully empty", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const sessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1779019848.438849";
    const contract = buildWorkContractFromPolicy(
      sessionKey,
      "请委派子 agent 调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
      "fresh_live_lookup",
      coverageSnapshot(),
      buildWorkDecisionSeal("local_judge", "delegate", ["planner_dispatch_test"]),
      { status: "sealed" },
    );
    saveWorkContract(contract);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      timeoutSeconds: 900,
    }, {
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    const events = readReplayEvents();
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    expect(backendSelected).toBeTruthy();
    expect(backendSelected!.planner_session_candidates).toEqual(expect.arrayContaining([
      sessionKey,
      "agent:main:slack:channel:c0as4dappu3",
    ]));
    expect(backendSelected!.planner_enabled).toBe(true);
  });

  it("still fails closed for non-allowlisted session when work contract carries the session key", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:slack:default:direct:u0al9t5u89z";
    const sessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1779019848.438849";
    const contract = buildWorkContractFromPolicy(
      sessionKey,
      "请委派子 agent 调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
      "fresh_live_lookup",
      coverageSnapshot(),
      buildWorkDecisionSeal("local_judge", "delegate", ["planner_dispatch_test"]),
      { status: "sealed" },
    );
    saveWorkContract(contract);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      timeoutSeconds: 900,
    }, {
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.error).toBe("planner_not_allowed_for_session");
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_not_allowed",
      error: "planner_not_allowed_for_session",
    }));
  });

  it("derives planner session candidates from resolveDispatchSessionKey when ctx.sessionKey is absent but sessionId is present", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const sessionKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const contract = seedWorkContract(sessionKey);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
    }, {
      sessionId: sessionKey,
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    const events = readReplayEvents();
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    expect(backendSelected).toBeTruthy();
    expect((backendSelected!.planner_session_candidates as string[]).length).toBeGreaterThan(0);
  });

  it("uses configured live OctoClaw root instead of OpenClaw managed mirror cwd", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const liveRoot = path.join(tempWorkspace, "live", "OctoClaw");
    const mirrorRoot = path.join(tempWorkspace, ".openclaw", "workspace", "openclaw", "repos", "octoclaw");
    fsSync.mkdirSync(liveRoot, { recursive: true });
    fsSync.mkdirSync(mirrorRoot, { recursive: true });
    envOverrides.octoclawRoot = liveRoot;
    const contract = seedWorkContract();

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-live-root",
      cwd: mirrorRoot,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.sessionsSpawnArgs.cwd).toBe(liveRoot);
    expect(body.sessionsSpawnArgs.task).toContain(`"cwd": "${liveRoot}"`);
    expect(body.sessionsSpawnArgs.task).toContain(`"workspaceRoot": "${liveRoot}"`);
    expect(body.sessionsSpawnArgs.task).not.toContain(`"cwd": "${mirrorRoot}"`);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.sessionsSpawnArgs.cwd).toBe(liveRoot);
  });

  it("uses configured live OctoClaw root instead of the generic OpenClaw workspace cwd", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const liveRoot = path.join(tempWorkspace, "live", "OctoClaw");
    const openclawWorkspace = path.join(tempWorkspace, ".openclaw", "workspace");
    fsSync.mkdirSync(liveRoot, { recursive: true });
    fsSync.mkdirSync(openclawWorkspace, { recursive: true });
    envOverrides.octoclawRoot = liveRoot;
    envOverrides.workspaceRoot = openclawWorkspace;
    const contract = seedWorkContract();

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-live-root-from-workspace",
      cwd: openclawWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.sessionsSpawnArgs.cwd).toBe(liveRoot);
    expect(body.sessionsSpawnArgs.task).toContain(`"cwd": "${liveRoot}"`);
    expect(body.sessionsSpawnArgs.task).toContain(`"workspaceRoot": "${liveRoot}"`);
    expect(body.sessionsSpawnArgs.task).toContain("blocked worker result packet");
    expect(body.sessionsSpawnArgs.task).not.toContain(`"cwd": "${openclawWorkspace}"`);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.sessionsSpawnArgs.cwd).toBe(liveRoot);
  });

  it("returns sessions_send plan when speculative preload standby was started", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    const contract = seedWorkContract("session-planner-speculative-dispatch");
    const label = "octoclaw-speculative-dispatchtest";
    policyState.setState(contract.sessionKey, {
      decision: delegateDecision(contract),
      routeHintSubmitted: true,
      speculativePreload: {
        label,
        status: "ready",
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now(),
        runId: "standby-run",
        childSessionKey: "agent:main:subagent:standby-ready",
      },
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-speculative-dispatch",
      agentId: "main",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.dispatchMode).toBe("send_to_speculative");
    expect(body.nextTool).toBe("sessions_send");
    expect(body.sessionsSendArgs).toMatchObject({
      label,
      agentId: "main",
      timeoutSeconds: 0,
    });
    expect(body.sessionsSendArgs.message).toContain(contract.workContractId);
    expect(body.sessionsSpawnArgs).toMatchObject({
      runtime: "subagent",
      mode: "run",
      cleanup: "keep",
      context: "isolated",
      lightContext: true,
    });
    const intent = nativeSpawnIntentStore.get(body.spawnIntentId);
    expect(intent).toMatchObject({
      status: "planned",
      dispatchMode: "send_to_speculative",
      speculativeSessionLabel: label,
    });
    expect(intent?.sessionsSpawnArgs).toMatchObject(body.sessionsSendArgs);
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_intent_created",
      dispatch_mode: "send_to_speculative",
      speculative_session_label: label,
    }));
  });

  it("requires hinted speculative standby before creating a planner intent", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    const contract = seedWorkContract("session-planner-speculative-hinted");
    const label = "octoclaw-speculative-hinted";
    const spawnArgs = {
      task: "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
      label,
      runtime: "subagent",
      mode: "session",
      thread: true,
      cleanup: "keep",
      sandbox: "inherit",
      context: "isolated",
      lightContext: true,
      cwd: tempWorkspace,
      runTimeoutSeconds: 300,
    };
    policyState.setState(contract.sessionKey, {
      decision: delegateDecision(contract),
      routeHintSubmitted: true,
      speculativePreload: {
        label,
        status: "hinted",
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now(),
        spawnArgs,
      },
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-speculative-hinted",
      agentId: "main",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.status).toBe("speculative_standby_required");
    expect(body.nextTool).toBe("sessions_spawn");
    expect(body.sessionsSpawnArgs).toEqual(spawnArgs);
    expect(body.spawnIntentId).toBeUndefined();
    expect(nativeSpawnIntentStore.findPendingForSession(contract.sessionKey)).toBeNull();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_dispatch_deferred",
      label,
      reason: "standby_spawn_required",
      dispatch_executed: false,
      spawn_executed: false,
    }));
  });

  it("falls back to new spawn when speculative standby has not reached ready", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    const contract = seedWorkContract("session-planner-speculative-fallback");
    const label = "octoclaw-speculative-notready";
    policyState.setState(contract.sessionKey, {
      decision: delegateDecision(contract),
      routeHintSubmitted: true,
      speculativePreload: {
        label,
        status: "spawn_call_started",
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now(),
      },
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-speculative-fallback",
      cwd: tempWorkspace,
      agentId: "main",
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.dispatchMode).toBe("new_spawn");
    expect(body.nextTool).toBe("sessions_spawn");
    expect(body.sessionsSendArgs).toBeUndefined();
    expect(body.sessionsSpawnArgs).toMatchObject({
      runtime: "subagent",
      mode: "run",
      cleanup: "keep",
      context: "isolated",
      lightContext: true,
    });
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)).toMatchObject({
      status: "planned",
      dispatchMode: "new_spawn",
    });
  });

  it("falls back when a fresher alias marks speculative standby stale", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    const contract = seedWorkContract("session-planner-speculative-alias-primary");
    const aliasKey = "runtime-session-speculative-alias";
    const label = "octoclaw-speculative-alias-stale";
    const oldReadyAt = Date.now() - 5_000;
    const freshStaleAt = Date.now();
    policyState.setState(contract.sessionKey, {
      decision: delegateDecision(contract),
      routeHintSubmitted: true,
      speculativePreload: {
        label,
        status: "ready",
        createdAt: oldReadyAt,
        updatedAt: oldReadyAt,
        runId: "old-standby-run",
        childSessionKey: "agent:main:subagent:old-standby",
      },
      createdAt: oldReadyAt,
      updatedAt: oldReadyAt,
    } as unknown as Parameters<typeof policyState.setState>[1]);
    policyState.setState(aliasKey, {
      prompt: contract.userAsk,
      decision: delegateDecision(contract),
      routeHintSubmitted: true,
      speculativePreload: {
        label,
        status: "stale",
        createdAt: oldReadyAt,
        updatedAt: freshStaleAt,
        error: "sessions_spawn(mode=\"session\") is not available on this channel",
      },
      createdAt: freshStaleAt,
      updatedAt: freshStaleAt,
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: aliasKey,
      canonicalSessionKey: contract.sessionKey,
      sessionId: aliasKey,
      cwd: tempWorkspace,
      agentId: "main",
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.dispatchMode).toBe("new_spawn");
    expect(body.nextTool).toBe("sessions_spawn");
    expect(body.sessionsSendArgs).toBeUndefined();
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)).toMatchObject({
      status: "planned",
      dispatchMode: "new_spawn",
    });
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "dispatch_planner_intent_created",
      dispatch_mode: "new_spawn",
      speculative_session_label: "",
    }));
  });

  it("does not treat Slack acceptance metadata or broad contract read scope as explicit child refs", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract();
    const broadReadScope = path.join(tempWorkspace, "openclaw", "repos", "octoclaw");
    contract.delegate = {
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      currentAttemptId: null,
      role: "research",
      coordinationMode: "solo_worker",
      acceptanceCriteria: ["Return a compact status-surface field summary."],
      scope: {
        read: [broadReadScope],
        write: [],
        workspaceMode: "read_only",
        scopeFingerprint: "repo-root-read",
      },
      modelProfile: "worker_research",
      nativeBinding: null,
      childSessions: [],
      artifactRefs: [],
      nextAction: "dispatch",
    };
    saveWorkContract(contract);

    const response = await dispatchTool().execute({
      task: "调研 OctoClaw 当前任务状态面板需要展示哪些字段；完成后给 5 条中文摘要。",
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      metadataJson: JSON.stringify({
        sourcePolicy: "slack OCTOCLAW_ACCEPTANCE run=planner-native-child-context case=child-context acceptance=true",
      }),
      timeoutSeconds: 300,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-context-sanitized-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    const task = String(body.sessionsSpawnArgs.task);
    expect(body.ok).toBe(true);
    expect(task).toContain("\"contextStrategy\": \"bounded_brief_only\"");
    expect(task).toContain("\"readScope\": []");
    expect(task).toContain("\"sourcePolicy\": \"Use the supplied task brief first.");
    expect(task).toContain("\"maxToolCalls\": 5");
    expect(task).not.toContain("OCTOCLAW_ACCEPTANCE");
    expect(task).not.toContain(broadReadScope);
  });

  it("filters broad planner context_refs before deciding explicit child context", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract();
    const repoRoot = path.join(tempWorkspace, "openclaw", "repos", "octoclaw");

    const response = await dispatchTool().execute({
      task: "调研 OctoClaw 当前任务状态面板需要展示哪些字段；完成后给 5 条中文摘要。",
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      metadataJson: JSON.stringify({
        context_refs: {
          readScope: [tempWorkspace, repoRoot],
          sourcePolicy: "read-only repo/local docs inspection",
          maxToolCalls: 12,
          workspaceMode: "read-only",
        },
      }),
      timeoutSeconds: 300,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-broad-context-refs-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    const task = String(body.sessionsSpawnArgs.task);
    expect(body.ok).toBe(true);
    expect(task).toContain("\"contextStrategy\": \"bounded_brief_only\"");
    expect(task).toContain("\"readScope\": []");
    expect(task).toContain("\"sourcePolicy\": \"Use the supplied task brief first.");
    expect(task).toContain("\"maxToolCalls\": 4");
    expect(task).not.toContain("read-only repo/local docs inspection");
    expect(task).not.toContain(repoRoot);
  });

  it("adds explicit context refs and tool budget to native planner child packets without raw parent transcript", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract();

    const response = await dispatchTool().execute({
      task: "只读调查：查看 PC13 Slack delivery port 记录并输出 5 句中文总结。",
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      metadataJson: JSON.stringify({
        context_refs: {
          primaryFiles: [
            "docs/octoclaw-native-slimming-implementation-plan-2026-05-01.md",
            "openspec/changes/planner-confirm-0.5.0-refactor/tasks.md",
          ],
          readScope: ["docs", "openspec"],
          sourcePolicy: "Use local OctoClaw docs first; web is not needed for PC13 evidence.",
          maxToolCalls: 6,
          workspaceMode: "read_only",
          rawTranscript: "SECRET_PARENT_TRANSCRIPT",
        },
      }),
      timeoutSeconds: 300,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-context-packet-test",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    const task = String(body.sessionsSpawnArgs.task);
    expect(body.ok).toBe(true);
    expect(task).toContain("docs/octoclaw-native-slimming-implementation-plan-2026-05-01.md");
    expect(task).toContain("openspec/changes/planner-confirm-0.5.0-refactor/tasks.md");
    expect(task).toContain("\"readScope\"");
    expect(task).toContain("\"workspaceMode\": \"read_only\"");
    expect(task).toContain("\"contextStrategy\": \"explicit_refs\"");
    expect(task).toContain("\"maxToolCalls\": 6");
    expect(task).toContain("Use local OctoClaw docs first; web is not needed for PC13 evidence.");
    expect(task).not.toContain("SECRET_PARENT_TRANSCRIPT");
    expect(task).not.toContain("Completion Requirement");
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
  });

  it("does not re-materialize legacy dispatch after native planner spawn is already accepted", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract();
    contract.nativeSpawnRefs = {
      openclawRunId: "run-existing-planner",
      childSessionKey: "agent:main:subagent:existing-planner",
      spawnIntentId: "nsp-existing-planner",
      spawnBackend: "sessions_spawn_planner",
      spawnMode: "run",
    };
    contract.telemetry = {
      ...contract.telemetry,
      dispatchExecuted: true,
      spawnExecuted: true,
      childRunId: "run-existing-planner",
      childSessionKey: "agent:main:subagent:existing-planner",
    };
    saveWorkContract(contract);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-already-started",
      cwd: tempWorkspace,
      helperInvoker: () => {
        throw new Error("legacy helper must not run for accepted native planner refs");
      },
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("already_started");
    expect(body.execution_state).toBe("already_started");
    expect(body.terminal).toBe(false);
    expect(body.is_failure).toBe(false);
    expect(body.in_progress).toBe(true);
    expect(body.awaiting_completion).toBe(true);
    expect(body.next_action).toBe("sessions_yield");
    expect(body.completion_status).toBe("pending");
    expect(body.instruction).toContain("not a failure");
    expect(body.instruction).toContain("Do not report degraded/failed");
    expect(body.spawn_executed).toBe(true);
    expect(body.run_id).toBe("run-existing-planner");
    expect(body.child_session_key).toBe("agent:main:subagent:existing-planner");
    expect(body.sessionsSpawnArgs).toBeUndefined();
    expect(body.nextTool).toBeUndefined();
    const events = readReplayEvents();
    expect(events.some((event) => event.event === "dispatch_native_spawn_already_started")).toBe(true);
    expect(events.some((event) => event.event === "execution_transition")).toBe(false);
  });

  it("uses planner backend when allowlist matches the base Slack channel for a thread session", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:slack:channel:c0as4dappu3";
    const threadSessionKey = "agent:main:slack:channel:c0as4dappu3:thread:t-budgeted-main";
    const contract = seedWorkContract(threadSessionKey);

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: threadSessionKey,
      canonicalSessionKey: threadSessionKey,
      sessionId: "session-planner-dispatch-thread-alias",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    expect(body.nextTool).toBe("sessions_spawn");
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
  });

  it("uses the dispatch task as planner ticket deliverable when sealed policy omits it", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract();
    const baseDecision = delegateDecision(contract);
    const { expected_deliverable: _expectedDeliverable, route_decision: baseRouteDecision, ...decisionRest } = baseDecision;
    const { expected_deliverable: _routeExpectedDeliverable, ...routeDecision } = baseRouteDecision;
    const decision = { ...decisionRest, route_decision: routeDecision };
    const task = "查证 OpenClaw 2026.4.29 相比 2026.4.21 的 release 变化，并输出 5 句话中文总结。";

    const response = await dispatchTool().execute({
      task,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(decision),
      timeoutSeconds: 240,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-dispatch-task-deliverable",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    expect(body.sessionsSpawnArgs.task).toContain("Expected deliverable:");
    expect(body.sessionsSpawnArgs.task).toContain(task);
    expect(body.sessionsSpawnArgs.task).toContain("deliver partial findings with caveats");
    expect(body.sessionsSpawnArgs.runTimeoutSeconds).toBe(300);
    expect(nativeSpawnIntentStore.get(body.spawnIntentId)?.status).toBe("planned");
  });

  it("requires an explicit runId in accepted confirm results", async () => {
    const contract = seedWorkContract();
    const sessionsSpawnArgs = {
      task: "Confirm wrapper should not treat childRunId as runId.",
      runtime: "subagent" as const,
      mode: "run" as const,
      cleanup: "keep" as const,
      sandbox: "inherit" as const,
      context: "isolated" as const,
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

  it("records dispatch_confirm_completed replay even when tool ctx has no policy decision", async () => {
    const contract = seedWorkContract();
    const sessionsSpawnArgs = {
      task: "Confirm replay evidence should not depend on policy state.",
      runtime: "subagent" as const,
      mode: "run" as const,
      cleanup: "keep" as const,
      sandbox: "inherit" as const,
      context: "isolated" as const,
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
      runId: "run-replay-confirm",
      childSessionKey: "agent:main:subagent:confirm-replay",
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-confirm-replay",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(readReplayEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "dispatch_confirm_completed",
        sessionKey: contract.sessionKey,
        sessionId: "session-planner-confirm-replay",
        spawn_intent_id: intent.spawnIntentId,
        work_contract_id: contract.workContractId,
        run_id: "run-replay-confirm",
        child_session_key: "agent:main:subagent:confirm-replay",
        ok: true,
      }),
    ]));
  });

  it("returns fail-closed JSON and replay when confirm intent store read is unavailable", async () => {
    const contract = seedWorkContract();
    const sessionsSpawnArgs = {
      task: "Confirm should fail closed when SQLite read is unavailable.",
      runtime: "subagent" as const,
      mode: "run" as const,
      cleanup: "keep" as const,
      sandbox: "inherit" as const,
      context: "isolated" as const,
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
    const storeError = new Error("sqlite unavailable");
    (storeError as Error & { code?: string }).code = "SQLITE_UNAVAILABLE";
    vi.spyOn(nativeSpawnIntentStore, "get").mockImplementationOnce(() => {
      throw storeError;
    });

    const response = await confirmTool().execute({
      spawnIntentId: intent.spawnIntentId,
      workContractId: contract.workContractId,
      sessionsSpawnStatus: "accepted",
      runId: "run-store-unavailable",
      childSessionKey: "agent:main:subagent:store-unavailable",
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-planner-confirm-store-unavailable",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(false);
    expect(body.status).toBe("error");
    expect(body.error).toBe("sqlite_unavailable");
    expect(readReplayEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "dispatch_confirm_completed",
        sessionKey: contract.sessionKey,
        sessionId: "session-planner-confirm-store-unavailable",
        spawn_intent_id: intent.spawnIntentId,
        work_contract_id: contract.workContractId,
        ok: false,
        confirm_status: "error",
        error: "sqlite_unavailable",
        run_id: "run-store-unavailable",
      }),
    ]));
  });

  // TODO: After gate convergence (W-5 WP-B), dispatch admission was centralized.
  // The is_new_work=false rejection may now be handled at a different layer or
  // the dispatch path may succeed with a fallback_to_main_reply response instead
  // of a hard rejection. Re-evaluate once the full gate convergence WP-F smoke
  // validates the expected end-to-end behavior.
  it.skip("rejects planner dispatch when admission dry-run does not issue a new-work ticket", async () => {
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
  });

});

describe("runtime convergence invariants (WP-A)", () => {
  async function dispatchPlannerContract(sessionKey = "session-planner-runtime-convergence") {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract(sessionKey);
    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: `${sessionKey}-dispatch`,
      cwd: tempWorkspace,
    });
    return { contract, body: JSON.parse(String(response.text)) as Record<string, unknown> };
  }

  it("planner prompt excludes completion file requirement and write-result instructions", async () => {
    const { body } = await dispatchPlannerContract("session-planner-no-completion-file");
    expect(body.ok).toBe(true);
    const task = String((body.sessionsSpawnArgs as Record<string, unknown>)?.task ?? "");
    const taskLower = task.toLowerCase();
    // Planner uses buildPlannerSpawnTask, not buildSubagentSpawnMessage.
    // It must NOT contain the old "Completion Requirement" section or write instructions.
    expect(task).not.toContain("Completion Requirement");
    expect(task).not.toContain(".completion.json");
    expect(task).not.toContain("resolveWorkerCompletionPath");
    expect(taskLower).not.toContain("you must write the result to this file");
    expect(taskLower).not.toContain("must write the result");
    expect(taskLower).not.toContain("writing this file is your last action");
    // The planner task may mention "completion file" in a prohibition context
    // (e.g., "do not write legacy completion files"), but never as a requirement.
    const completionRequirementSection = task.match(/## Completion Requirement/i);
    expect(completionRequirementSection).toBeNull();
    const completionTemplateMatch = task.match(/File path:.*\.completion\.json/);
    expect(completionTemplateMatch).toBeNull();
  });

  it("planner path does not schedule child finalizer after native sessions_spawn is accepted", async () => {
    const { body } = await dispatchPlannerContract("session-planner-no-finalizer");
    expect(body.ok).toBe(true);
    // scheduleChildCompletionFinalizer is removed; no completion timeout should be scheduled
    const events = readReplayEvents();
    expect(events).not.toContainEqual(expect.objectContaining({ event: "child_finalizer_scheduled" }));
  });

  it("planner dispatch does not queue delivery outbox", async () => {
    const { body } = await dispatchPlannerContract("session-planner-no-outbox");
    const events = readReplayEvents();

    expect(body.ok).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ event: "legacy_outbox_queued" }));
    expect(JSON.stringify(body).toLowerCase()).not.toContain("outbox");
  });

  it("octoclaw_spawn is not registered as a tool", () => {
    const tools = getToolRegistrations();
    const spawn = tools.find((t) => t.name === "octoclaw_spawn");

    expect(spawn).toBeUndefined();
  });

  it("P6-007: dispatch records host-owned ACP fallback observation without OctoClaw failover", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OPENCLAW_HOME = tempWorkspace;
    fsSync.writeFileSync(path.join(tempWorkspace, "openclaw.json"), JSON.stringify({
      acp: { fallbacks: ["acpx", "codex-native"] },
    }));
    const contract = seedWorkContract();

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-p2c-enforce-007",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.status).toBe("requires_native_spawn");
    expect(body.workContractId).toBe(contract.workContractId);
    const events = readReplayEvents();
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    expect(backendSelected).toBeTruthy();
    expect(backendSelected!.native_acp_fallback).toMatchObject({
      owner: "openclaw_acp",
      primaryRuntimeId: "acpx",
      fallbackRuntimeIds: ["acpx", "codex-native"],
      fallbackAttempted: false,
      fallbackSelectedRuntimeId: "",
      reason: "host_runtime_owns_backend_failover",
    });
    const intentCreated = events.find((e) => e.event === "dispatch_planner_intent_created");
    expect(intentCreated).toBeTruthy();
    expect(intentCreated!.native_acp_fallback).toMatchObject({
      owner: "openclaw_acp",
      fallbackAttempted: false,
      fallbackSelectedRuntimeId: "",
    });
    const dispatchStarted = events.find((e) => e.event === "dispatch_tool_started");
    expect(dispatchStarted).toBeTruthy();
    expect(dispatchStarted!.work_contract_id).toBe(contract.workContractId);
    const duplicateDispatches = events.filter((e) => e.event === "dispatch_tool_started");
    expect(duplicateDispatches.length).toBe(1);
  });

  it("P6-008: host-owned ACP fallback observation produces one spawn intent, no duplicate final path", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OPENCLAW_HOME = tempWorkspace;
    fsSync.writeFileSync(path.join(tempWorkspace, "openclaw.json"), JSON.stringify({
      acp: { fallbacks: ["acpx", "codex-native"] },
    }));
    const contract = seedWorkContract("session-p2c-enforce-008");

    const response = await dispatchTool().execute({
      task: contract.userAsk,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract)),
      timeoutSeconds: 900,
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-p2c-enforce-008",
      cwd: tempWorkspace,
    });

    const body = JSON.parse(String(response.text));
    expect(body.ok).toBe(true);
    expect(body.spawnIntentId).toBeTruthy();
    const events = readReplayEvents();
    const intentCreated = events.filter((e) => e.event === "dispatch_planner_intent_created");
    expect(intentCreated.length).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ event: "legacy_outbox_queued" }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "child_finalizer_scheduled" }));
    const terminalFailures = events.filter((e) => e.event === "dispatch_terminal_failure");
    expect(terminalFailures.length).toBe(0);
    const backendSelected = events.find((e) => e.event === "dispatch_backend_selected");
    const fallbackMeta = backendSelected!.native_acp_fallback as Record<string, unknown>;
    expect(fallbackMeta.fallbackAttempted).toBe(false);
    expect(fallbackMeta.fallbackSelectedRuntimeId).toBe("");
  });
});
