import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../extension-entry.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { policyState } from "../state/policy-state.js";
import { getToolRegistrations } from "../tools/registration.js";
import { envOverrides } from "../resolve/env.js";
import { resolvePolicyDecisionForContext } from "../resolve/policy-resolver.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { resetNeutralInboundAckDedupeForTests } from "../ack/ack-guard.js";
import { BUDGETED_MAIN_MAX_WALL_MS } from "../budgeted-main.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };
let tempWorkspace = "";
let originalRuntimeDbPath: string | undefined;
let originalWorkspaceEnv: string | undefined;
const ENV_KEYS = [
  "OCTOCLAW_SPAWN_BACKEND",
  "OCTOCLAW_PLANNER_ALLOWLIST",
  "OCTOCLAW_SPECULATIVE_PRELOAD",
  "OCTOCLAW_RUNTIME_LEDGER",
  "OCTOCLAW_SCHEDULER_ENABLED",
  "OCTOCLAW_TASK_STATE_REBUILD",
  "OCTOCLAW_DELEGATION",
  "OCTOCLAW_ROUTE_HINT",
] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};


function coverageSnapshot(): ContextCoverageSnapshot {
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
    ] as ContextCoverageSnapshot["precheckOrder"],
    execution: { status: "missing", signals: ["missing"] } as ContextCoverageSnapshot["execution"],
    memory: { status: "missing", signals: [] } as ContextCoverageSnapshot["memory"],
    conflict: false,
    authority: "none" as const,
  };
}

async function waitForFireAndForget(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function readReplayEvents(): Array<Record<string, unknown>> {
  const replayLogPath = path.join(tempWorkspace, "tmp", "octopus", "runtime-policy-replay.jsonl");
  if (!fsSync.existsSync(replayLogPath)) return [];
  return fsSync.readFileSync(replayLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function budgetedMainDecision(route = "reply"): Record<string, unknown> {
  const delegateRoute = route === "delegate";
  return {
    runtime_switches: { replay_logging_enabled: true },
    route_decision: {
      route,
      route_source: "rule",
      decision_bucket: "budgeted_main_then_delegate",
    },
    hook_interface: {
      before_prompt_build: { enabled: true },
      before_tool_call: {
        enabled: true,
        route_hint_required: false,
        route_hint_tool: "octoclaw_route_hint",
        delegation_enforcement: true,
      },
    },
    route_hint_policy: { required: false, submitted: false },
    tool_policy: {
      allow_direct_tools: !delegateRoute,
      ...(delegateRoute ? { must_delegate_via: "octoclaw_dispatch" } : {}),
      allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
    },
  };
}


function budgetedMainState(startedAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    startedAt,
    started_at: startedAt,
    maxWallMs: BUDGETED_MAIN_MAX_WALL_MS,
    max_wall_ms: BUDGETED_MAIN_MAX_WALL_MS,
    budgetStartSource: "before_prompt_build_complete",
    budget_start_source: "before_prompt_build_complete",
    reason: "budgeted_main_started",
    decisionBucket: "budgeted_main_then_delegate",
    decision_bucket: "budgeted_main_then_delegate",
    visibleStartAt: startedAt - 2_000,
    visible_start_at: startedAt - 2_000,
    toolCount: 0,
    tool_count: 0,
    readOnlyToolCount: 0,
    read_only_tool_count: 0,
    longToolDetected: false,
    long_tool_detected: false,
    writeToolDetected: false,
    write_tool_detected: false,
    ...extra,
  };
}

beforeEach(() => {
  originalRuntimeDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
  originalWorkspaceEnv = process.env.WORKSPACE;
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-extension-entry-"));
  envOverrides.workspaceRoot = tempWorkspace;
  envOverrides.octoclawRoot = "";
  process.env.WORKSPACE = tempWorkspace;
  process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tempWorkspace, ".octoclaw", "runtime", "octoclaw-runtime.sqlite");
});

afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  resetNeutralInboundAckDedupeForTests();
  for (const entry of policyState.entries()) {
    policyState.clear(entry.key);
  }
  envOverrides.workspaceRoot = "";
  envOverrides.octoclawRoot = "";
  if (originalRuntimeDbPath === undefined) delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
  else process.env.OCTOCLAW_RUNTIME_DB_PATH = originalRuntimeDbPath;
  if (originalWorkspaceEnv === undefined) delete process.env.WORKSPACE;
  else process.env.WORKSPACE = originalWorkspaceEnv;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv = {};
  originalRuntimeDbPath = undefined;
  originalWorkspaceEnv = undefined;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});


describe("octoclaw_route_hint policy state aliases", () => {
  it("rematerializes a cached delegate WorkContract when the backing store is missing", async () => {
    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-rematerialize";
    const prompt = "请委派子 agent 做一次只读验收并返回结论";
    policyState.setState(key, {
      prompt,
      decision: {
        ...budgetedMainDecision("delegate"),
        workContractId: "wc-missing-cache",
        work_contract: {
          workContractId: "wc-missing-cache",
          route: "delegate",
          status: "sealed",
        },
      },
      workContractId: "wc-missing-cache",
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
    });

    const resolved = await resolvePolicyDecisionForContext(prompt, {
      sessionKey: key,
      sessionId: "session-rematerialize",
      agentId: "main",
      channelId: "slack",
      cwd: tempWorkspace,
    }, tempWorkspace);

    const rematerializedId = String(resolved?.decision.workContractId ?? "");
    expect(rematerializedId).toMatch(/^wc-/);
    expect(rematerializedId).not.toBe("wc-missing-cache");
    expect(loadWorkContract(rematerializedId)?.status).toBe("sealed");
    expect(policyState.getState(key)?.workContractId).toBe(rematerializedId);
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "work_contract_cache_rematerialized",
      staleWorkContractId: "wc-missing-cache",
      workContractId: rematerializedId,
    }));

    policyState.clearState(key);
  });

  it("does not treat old Slack acceptance suitability text as hard delegate when judge replies", async () => {
    const previousJudgeFast = process.env.OCTOCLAW_JUDGE_FAST;
    process.env.OCTOCLAW_JUDGE_FAST = JSON.stringify({
      enabled: true,
      shadowMode: false,
      modelId: "test-local-judge",
      baseUrl: "http://localhost:19999/v1",
      apiKey: "test-key",
      timeoutMs: 1500,
      timeoutLocalMs: 800,
      minConfidence: 0.6,
      local: true,
      judgeAckEnabled: true,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          route: "reply",
          confidence: 0.9,
          complexity: "simple",
          complexity_confidence: 0.74,
          abstain_reason: null,
          ack_text: "收到",
        }) } }],
      }),
    } as Response);
    const sessionKey = "agent:main:slack:channel:c0as4dappu3";
    const prompt = "[OCTOCLAW_ACCEPTANCE] run=planner-native-spawn-test case=delegated_work acceptance=true\n<@U0ARU7EKGCQ> 这是自动化验收消息。请查一下 OpenClaw 2026.4.29 相比 2026.4.21 的 release 变化，并给我 5 句话中文总结。需要真实查证，适合委派子 agent。";

    try {
      const resolved = await resolvePolicyDecisionForContext(prompt, {
        sessionKey,
        sessionId: "slack-session-policy-release-lookup",
        agentId: "main",
        channelId: "slack",
        messageId: "1777702814.113479",
      }, tempWorkspace);

      expect(fetchSpy).toHaveBeenCalled();
      expect(resolved?.decision.request).toMatchObject({
        metadata: {
          intent_packet: {
            intent_class: "fresh_live_lookup",
            source: "deterministic_live_lookup_classifier",
          },
        },
      });
      expect(resolved?.decision.route_decision).toMatchObject({
        route: "reply",
        decision_bucket: "budgeted_main_then_delegate",
        hard_delegate_signal: false,
      });
      expect(resolved?.decision).not.toMatchObject({ is_new_work: true });
      expect(resolved?.decision.tool_policy).toMatchObject({
        must_delegate_via: "",
      });
      expect(policyState.getState(sessionKey)?.decision?.route_decision).toMatchObject({
        route: "reply",
        decision_bucket: "budgeted_main_then_delegate",
      });
    } finally {
      if (previousJudgeFast === undefined) delete process.env.OCTOCLAW_JUDGE_FAST;
      else process.env.OCTOCLAW_JUDGE_FAST = previousJudgeFast;
      policyState.clearState(sessionKey);
    }
  });

  it("stores the merged route on every current context alias", async () => {
    const key = "agent:main:slack:default:direct:u0al9t5u89z";
    const alias = "session-alias-route-hint";
    policyState.clearState(key);
    policyState.clearState(alias);

    const routeHint = getToolRegistrations().find((tool) => tool.name === "octoclaw_route_hint");
    expect(routeHint).toBeTruthy();
    const result = await routeHint!.execute({
      task: "hello",
      routeHint: "reply",
      confidence: 0.9,
      reason: "direct answer",
    }, { sessionKey: key, sessionId: alias, agentId: "main" });

    expect(JSON.stringify(result)).toContain("final route is reply");
    expect(policyState.getState(key)?.routeHintSubmitted).toBe(true);
    expect(policyState.getState(alias)?.routeHintSubmitted).toBe(true);

    policyState.clearState(key);
    policyState.clearState(alias);
  });


  it("passes plugin judge config into route_hint tools", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          route: "delegate",
          confidence: 0.9,
          complexity: "normal",
          complexity_confidence: 0.74,
          abstain_reason: null,
          is_new_work: true,
          expected_deliverable: "implemented nightly replay AI interpretation report",
          scope: "local",
          tool_need_hint: "required",
          duration_hint: "medium",
        }) } }],
      }),
    } as Response);
    const key = "agent:main:slack:default:direct:u0routehint";
    policyState.clearState(key);

    const routeHint = getToolRegistrations({
      judgeFastRaw: {
        enabled: true,
        shadowMode: false,
        modelId: "test-local-judge",
        baseUrl: "http://localhost:19999/v1",
        apiKey: "test-key",
        timeoutMs: 1500,
        timeoutLocalMs: 800,
        minConfidence: 0.6,
        local: true,
        judgeAckEnabled: true,
      },
      delegationEnabled: true,
    }).find((tool) => tool.name === "octoclaw_route_hint");
    expect(routeHint).toBeTruthy();

    const result = await routeHint!.execute({
      task: "实现 nightly replay 后的 AI 解读报告",
      routeHint: "delegate",
      requestedRoute: "delegate",
      workType: "code",
      phase: "implement",
      confidence: 0.95,
    }, { sessionKey: key, agentId: "main", messageId: "1777556160.478629" });

    expect(fetchSpy).toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("final route is delegate");
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({ route: "delegate" });
    policyState.clearState(key);
  });
});

describe("plugin enabled config", () => {
  it("does not register hooks or tools when disabled", () => {
    const on = vi.fn();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const info = vi.fn();

    plugin.register({
      pluginConfig: { enabled: false },
      on,
      registerTool,
      registerCommand,
      logger: { info },
    });

    expect(on).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("octoclaw-runtime: disabled via config (enabled=false), skipping hook registration");
  });
});

describe("budgeted_main_then_delegate runtime budget", () => {
  it("starts the 30s soft budget after before_prompt_build and records replay metrics", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-start";
    const prompt = "查一下 OpenClaw 最新版本号";
    const now = Date.now();
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision(),
      createdAt: now - 2_000,
      updatedAt: now,
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const agentEnd = handlers.get("agent_end");
    expect(beforePromptBuild).toBeTruthy();
    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-budget-start", agentId: "main", channelId: "slack" },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("budgeted main execution");
    expect(projection?.prependSystemContext).toContain("metadataJson.context_refs");
    expect(projection?.prependSystemContext).toContain("one lightweight read-only lookup");
    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: true,
      reason: "budgeted_main_started",
      maxWallMs: BUDGETED_MAIN_MAX_WALL_MS,
      budgetStartSource: "before_prompt_build_complete",
    });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "before_prompt_build_started",
      stateKey: key,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "policy_resolve_started",
      stateKey: key,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "policy_resolve_cache_hit",
      stateKey: key,
      usedCachedPolicy: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "policy_resolve_completed",
      stateKey: key,
      usedCachedPolicy: true,
      decision_bucket: "budgeted_main_then_delegate",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "prompt_projection_built",
      stateKey: key,
      decision_bucket: "budgeted_main_then_delegate",
      projectionReturned: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_started",
      reason: "budgeted_main_started",
      max_wall_ms: BUDGETED_MAIN_MAX_WALL_MS,
      budget_start_source: "before_prompt_build_complete",
    }));
    await agentEnd?.({}, { sessionKey: key, sessionId: "session-budget-start", agentId: "main" });
    policyState.clearState(key);
  });

  it("records prompt timing replay even when cached decision lacks replay runtime switch", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-timing-no-switch";
    const prompt = "查一下 OpenClaw 最新版本号";
    const decision = budgetedMainDecision();
    delete decision.runtime_switches;
    policyState.setState(key, {
      prompt,
      decision,
      createdAt: Date.now() - 2_000,
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    expect(beforePromptBuild).toBeTruthy();
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-budget-timing-no-switch", agentId: "main", channelId: "slack" },
    );

    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "policy_resolve_cache_hit",
      stateKey: key,
      usedCachedPolicy: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "policy_resolve_completed",
      stateKey: key,
      usedCachedPolicy: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "prompt_projection_built",
      stateKey: key,
    }));
    policyState.clearState(key);
  });

  it("records completion within the 30s main execution budget without spawning", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-complete";
    const now = Date.now();
    policyState.setState(key, {
      decision: budgetedMainDecision(),
      budgetedMain: budgetedMainState(now - 1_000),
      budgeted_main: budgetedMainState(now - 1_000),
      createdAt: now - 2_000,
      updatedAt: now,
    });

    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeMessageWrite).toBeTruthy();
    const result = beforeMessageWrite!(
      { message: { role: "assistant", content: "可以，结论是 A。" } },
      { sessionKey: key, sessionId: "session-budget-complete", agentId: "main", channelId: "slack" },
    ) as { message?: { content?: unknown } } | undefined;

    expect(String(result?.message?.content ?? "可以，结论是 A。")).not.toBe("NO_REPLY");
    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: false,
      reason: "completed",
    });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_completed",
      reason: "completed",
      decision_bucket: "budgeted_main_then_delegate",
      max_wall_ms: BUDGETED_MAIN_MAX_WALL_MS,
      budget_start_source: "before_prompt_build_complete",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "sessions_spawn_intent_allowed" }));
    policyState.clearState(key);
  });

  it("allows a late final reply after soft timeout and does not spawn", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-late-final";
    const now = Date.now();
    const lateBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 2_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
    });
    policyState.setState(key, {
      decision: budgetedMainDecision(),
      budgetedMain: lateBudget,
      budgeted_main: lateBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforeMessageWrite = handlers.get("before_message_write");
    expect(beforeMessageWrite).toBeTruthy();
    beforeMessageWrite!(
      { message: { role: "assistant", content: "已经直接回答完了。" } },
      { sessionKey: key, sessionId: "session-budget-late-final", agentId: "main", channelId: "slack" },
    );

    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: false,
      reason: "completed_late",
    });
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({ route: "reply" });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_completed_late",
      reason: "completed_late",
      budgetEscalationReason: "",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "sessions_spawn_intent_allowed" }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "dispatch_confirm_completed" }));
    policyState.clearState(key);
  });

  it("does not convert a pending soft timeout into delegate at prompt injection", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-prompt-pending";
    const prompt = "明天北京天气咋样";
    const now = Date.now();
    const pendingBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 1_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
    });
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision(),
      budgetedMain: pendingBudget,
      budgeted_main: pendingBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    expect(beforePromptBuild).toBeTruthy();
    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-budget-prompt-pending", agentId: "main", channelId: "slack" },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("soft-budget notice");
    expect(projection?.prependSystemContext).toContain("at most one lightweight read-only tool");
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
    });
    expect(policyState.getState(key)).not.toMatchObject({
      dispatchStatus: "budgeted_main_escalated",
    });
    await waitForFireAndForget();
    expect(readReplayEvents()).not.toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
    }));
    policyState.clearState(key);
  });

  it("allows one lightweight read-only tool after soft timeout without escalating", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-timeout-tool";
    const now = Date.now();
    const pendingBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 1_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
    });
    policyState.setState(key, {
      decision: budgetedMainDecision(),
      budgetedMain: pendingBudget,
      budgeted_main: pendingBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "read", params: { path: "README.md" } },
      { sessionKey: key, sessionId: "session-budget-timeout-tool", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(result).toBeUndefined();
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({
      route: "reply",
      decision_bucket: "budgeted_main_then_delegate",
    });
    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: true,
      escalatedPending: true,
      readOnlyToolCount: 1,
      toolCount: 1,
    });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "sessions_spawn_intent_allowed" }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "dispatch_confirm_completed" }));
    policyState.clearState(key);
  });

  it("does not spend the late read-only budget on skill prep reads", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-timeout-skill-read";
    const now = Date.now();
    const pendingBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 1_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
    });
    policyState.setState(key, {
      decision: budgetedMainDecision(),
      budgetedMain: pendingBudget,
      budgeted_main: pendingBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const prepResult = await beforeToolCall!(
      { toolName: "read", params: { path: "/Users/guanbear/.openclaw/skills/weather/SKILL.md" } },
      { sessionKey: key, sessionId: "session-budget-timeout-skill-read", agentId: "main" },
    );
    const lookupResult = await beforeToolCall!(
      { toolName: "exec", params: { command: "curl -s 'https://wttr.in/Beijing?format=j1'" } },
      { sessionKey: key, sessionId: "session-budget-timeout-skill-read", agentId: "main" },
    );

    expect(prepResult).toBeUndefined();
    expect(lookupResult).toBeUndefined();
    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: true,
      escalatedPending: true,
      readOnlyToolCount: 1,
      toolCount: 1,
    });
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({ route: "reply" });
    await waitForFireAndForget();
    expect(readReplayEvents()).not.toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
    }));
    policyState.clearState(key);
  });

  it("blocks a second real read-only tool after soft timeout and requires octoclaw_dispatch", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-timeout-second-tool";
    const now = Date.now();
    const pendingBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 1_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
      readOnlyToolCount: 1,
      read_only_tool_count: 1,
      toolCount: 1,
      tool_count: 1,
    });
    policyState.setState(key, {
      decision: budgetedMainDecision(),
      budgetedMain: pendingBudget,
      budgeted_main: pendingBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "web_fetch", params: { url: "https://example.com" } },
      { sessionKey: key, sessionId: "session-budget-timeout-second-tool", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("Call octoclaw_dispatch");
    expect(result?.blockReason).toContain("multi_step_tool_chain");
    expect(policyState.getState(key)?.decision?.route_decision).toMatchObject({
      route: "delegate",
      route_source: "budgeted_main_escalation",
      is_new_work: true,
    });
    expect(policyState.getState(key)?.decision).toMatchObject({ is_new_work: true });
    expect(policyState.getState(key)).toMatchObject({
      dispatchStatus: "budgeted_main_escalated",
      dispatchExecuted: false,
      spawnExecuted: false,
    });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
      reason: "multi_step_tool_chain",
      budgetEscalationReason: "multi_step_tool_chain",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "sessions_spawn_intent_allowed" }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "dispatch_confirm_completed" }));
    policyState.clearState(key);
  });

  it("allows octoclaw_dispatch after timeout so the native planner path can run", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-timeout-dispatch";
    const runtimeSessionId = "session-budget-timeout-dispatch";
    const now = Date.now();
    const prompt = "整理这轮 SR-P1 evidence";
    const initialReplyContract = buildWorkContractFromPolicy(
      key,
      prompt,
      "undetermined",
      coverageSnapshot(),
      buildWorkDecisionSeal("local_judge", "reply", ["budgeted_main_initial_reply"]),
      {
        reply: {
          replyMode: "answer",
          grounding: "none",
          allowedTools: [],
          forbiddenTools: ["octoclaw_dispatch", "spawn"],
          evidenceRefs: [],
        },
      },
    );
    expect(saveWorkContract(initialReplyContract)).toBe(true);
    const pendingBudget = budgetedMainState(now - BUDGETED_MAIN_MAX_WALL_MS - 1_000, {
      escalatedPending: true,
      escalated_pending: true,
      reason: "wall_time_over_budget",
      workContractId: initialReplyContract.workContractId,
      work_contract_id: initialReplyContract.workContractId,
    });
    policyState.setState(runtimeSessionId, {
      prompt,
      canonicalSessionKey: key,
      workContractId: initialReplyContract.workContractId,
      work_contract_id: initialReplyContract.workContractId,
      decision: {
        ...budgetedMainDecision(),
        workContractId: initialReplyContract.workContractId,
        work_contract: {
          workContractId: initialReplyContract.workContractId,
          work_contract_id: initialReplyContract.workContractId,
          route: "reply",
          status: "sealed",
          forbiddenTools: ["octoclaw_dispatch", "spawn"],
        },
      },
      budgetedMain: pendingBudget,
      budgeted_main: pendingBudget,
      createdAt: now - 35_000,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "整理这轮 SR-P1 evidence" } },
      { sessionKey: key, sessionId: runtimeSessionId, agentId: "main" },
    );

    expect(result).toBeUndefined();
    expect(policyState.getState(runtimeSessionId)?.decision?.route_decision).toMatchObject({
      route: "delegate",
      route_source: "budgeted_main_escalation",
      is_new_work: true,
    });
    expect(policyState.getState(runtimeSessionId)?.decision).toMatchObject({ is_new_work: true });
    const escalatedState = policyState.getState(runtimeSessionId);
    const escalatedWorkContractId = String(escalatedState?.workContractId ?? "");
    expect(escalatedWorkContractId).toBeTruthy();
    expect(escalatedWorkContractId).not.toBe(initialReplyContract.workContractId);
    expect(escalatedState?.decision?.work_contract).toMatchObject({
      workContractId: escalatedWorkContractId,
      route: "delegate",
      status: "sealed",
    });
    expect(loadWorkContract(initialReplyContract.workContractId)?.route).toBe("reply");
    expect(loadWorkContract(escalatedWorkContractId)).toMatchObject({
      route: "delegate",
      sessionKey: key,
    });
    expect(policyState.getState(runtimeSessionId)?.canonicalSessionKey).toBe(key);
    expect(policyState.getState(key)?.workContractId).toBe(escalatedWorkContractId);
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
      reason: "wall_time_over_budget",
      workContractId: escalatedWorkContractId,
    }));
    policyState.clearState(runtimeSessionId);
    policyState.clearState(key);
  });

  it("immediately escalates write and verification tools without waiting for 30s", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const now = Date.now();
    const writeKey = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-write-tool";
    policyState.setState(writeKey, {
      decision: budgetedMainDecision(),
      budgetedMain: budgetedMainState(now - 1_000),
      budgeted_main: budgetedMainState(now - 1_000),
      createdAt: now - 2_000,
      updatedAt: now,
    });
    const writeResult = await beforeToolCall!(
      { toolName: "write", params: { path: "docs/example.md", content: "x" } },
      { sessionKey: writeKey, sessionId: "session-budget-write-tool", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    const longKey = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-long-tool";
    policyState.setState(longKey, {
      decision: budgetedMainDecision(),
      budgetedMain: budgetedMainState(now - 1_000),
      budgeted_main: budgetedMainState(now - 1_000),
      createdAt: now - 2_000,
      updatedAt: now,
    });
    const longResult = await beforeToolCall!(
      { toolName: "exec", params: { command: "pnpm test" } },
      { sessionKey: longKey, sessionId: "session-budget-long-tool", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(writeResult?.block).toBe(true);
    expect(writeResult?.blockReason).toContain("write_tool_detected");
    expect(longResult?.block).toBe(true);
    expect(longResult?.blockReason).toContain("long_tool_detected");
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
      reason: "write_tool_detected",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
      reason: "long_tool_detected",
    }));
    policyState.clearState(writeKey);
    policyState.clearState(longKey);
  });

  it("does not start budget escalation for must_reply or must_delegate buckets", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const now = Date.now();
    const replyKey = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-must-reply";
    policyState.setState(replyKey, {
      decision: {
        route_decision: { route: "reply", decision_bucket: "must_reply" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: { allow_direct_tools: true },
      },
      createdAt: now,
      updatedAt: now,
    });
    const replyResult = await beforeToolCall!(
      { toolName: "read", params: { path: "README.md" } },
      { sessionKey: replyKey, sessionId: "session-budget-must-reply", agentId: "main" },
    );

    const delegateKey = "agent:main:slack:channel:c0as4dappu3:thread:t-budget-must-delegate";
    policyState.setState(delegateKey, {
      decision: {
        route_decision: { route: "delegate", decision_bucket: "must_delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      routeHintSubmitted: true,
      createdAt: now,
      updatedAt: now,
    });
    const delegateResult = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "run the delegated work" } },
      { sessionKey: delegateKey, sessionId: "session-budget-must-delegate", agentId: "main" },
    );

    expect(replyResult).toBeUndefined();
    expect(delegateResult).toBeUndefined();
    await waitForFireAndForget();
    expect(readReplayEvents()).not.toContainEqual(expect.objectContaining({
      event: expect.stringMatching(/^budgeted_main_/),
    }));
    policyState.clearState(replyKey);
    policyState.clearState(delegateKey);
  });
});

describe("speculative preload planner path", () => {
  afterEach(() => {
    delete process.env.OCTOCLAW_SPECULATIVE_PRELOAD;
    delete process.env.OCTOCLAW_SPAWN_BACKEND;
  });

  it("injects a standby sessions_spawn hint and allows only the matching speculative spawn", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const beforeToolCall = handlers.get("before_tool_call");
    const afterToolCall = handlers.get("after_tool_call");
    expect(beforePromptBuild).toBeTruthy();
    expect(beforeToolCall).toBeTruthy();
    expect(afterToolCall).toBeTruthy();

    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("OCTOCLAW_SPECULATIVE_SPAWN_HINT");
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative).toMatchObject({ status: "hinted" });
    const spawnArgs = speculative.spawnArgs as Record<string, unknown>;
    expect(spawnArgs).toMatchObject({
      mode: "session",
      thread: true,
      lightContext: true,
      context: "isolated",
    });

    const prematureDispatch = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: prompt } },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    const blocked = await beforeToolCall!(
      { toolName: "sessions_spawn", params: { ...spawnArgs, label: "octoclaw-speculative-wrong" } },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    const blockedContext = await beforeToolCall!(
      { toolName: "sessions_spawn", params: { ...spawnArgs, context: "full" } },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    const allowed = await beforeToolCall!(
      { toolName: "sessions_spawn", params: spawnArgs },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main" },
    );

    expect(allowed).toBeUndefined();
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({ status: "spawn_call_started" });
    expect(prematureDispatch?.block).toBe(true);
    expect(prematureDispatch?.blockReason).toContain("First call sessions_spawn");
    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain("Call octoclaw_dispatch");
    expect(blockedContext?.block).toBe(true);
    expect(blockedContext?.blockReason).toContain("Call octoclaw_dispatch");
    await afterToolCall!(
      {
        toolName: "sessions_spawn",
        params: spawnArgs,
        result: {
          status: "accepted",
          runId: "run-spec-preload",
          childSessionKey: "agent:main:subagent:spec-preload",
        },
        durationMs: 1234,
      },
      { sessionKey: key, sessionId: "session-spec-preload", agentId: "main" },
    );
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "ready",
      runId: "run-spec-preload",
      childSessionKey: "agent:main:subagent:spec-preload",
    });
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "speculative_preload_hint_injected",
      sessionKey: key,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_allowed",
      sessionKey: key,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "speculative_preload_dispatch_deferred",
      sessionKey: key,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_ready",
      sessionKey: key,
      run_id: "run-spec-preload",
      child_session_key: "agent:main:subagent:spec-preload",
    }));
    policyState.clearState(key);
  });

  it("defers octoclaw_dispatch for hinted standby even when generic tool hook enforcement is disabled", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-hook-disabled";
    const prompt = "请委派子 agent 做一次 Scheme B review";
    const decision = budgetedMainDecision("delegate");
    const hookInterface = decision.hook_interface as Record<string, unknown>;
    hookInterface.before_tool_call = {
      ...(hookInterface.before_tool_call as Record<string, unknown>),
      enabled: false,
    };
    policyState.setState(key, {
      prompt,
      decision,
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const beforeToolCall = handlers.get("before_tool_call");
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-hook-disabled", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const blocked = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: prompt } },
      { sessionKey: key, sessionId: "session-spec-preload-hook-disabled", agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain("First call sessions_spawn");
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_dispatch_deferred",
      sessionKey: key,
    }));
    policyState.clearState(key);
  });

  it("enforces hinted speculative standby across session id aliases", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-alias";
    const aliasKey = "runtime-session-spec-preload-alias";
    const workContractId = "wc-spec-preload-alias";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      workContractId,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const beforeToolCall = handlers.get("before_tool_call");
    const afterToolCall = handlers.get("after_tool_call");
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: aliasKey, agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative).toMatchObject({ status: "hinted" });
    policyState.setState(aliasKey, {
      prompt,
      workContractId,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      speculativePreload: speculative,
      speculative_preload: speculative,
      createdAt: Date.now() + 1,
      updatedAt: Date.now() + 1,
    });

    const prematureDispatch = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: prompt } },
      { sessionKey: key, sessionId: aliasKey, agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    expect(prematureDispatch?.block).toBe(true);
    expect(prematureDispatch?.blockReason).toContain("First call sessions_spawn");

    const allowed = await beforeToolCall!(
      { toolName: "sessions_spawn", params: speculative.spawnArgs },
      { sessionKey: key, sessionId: aliasKey, agentId: "main" },
    );
    expect(allowed).toBeUndefined();
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({ status: "spawn_call_started" });

    await afterToolCall!(
      {
        toolName: "sessions_spawn",
        params: speculative.spawnArgs,
        result: {
          status: "accepted",
          runId: "run-spec-preload-alias",
          childSessionKey: "agent:main:subagent:spec-preload-alias",
        },
      },
      { sessionKey: key, sessionId: aliasKey, agentId: "main" },
    );
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "ready",
      runId: "run-spec-preload-alias",
      childSessionKey: "agent:main:subagent:spec-preload-alias",
    });
    policyState.clearState(key);
    policyState.clearState(aliasKey);
  });

  it("points speculative standby at configured live OctoClaw root when ctx cwd is an OpenClaw mirror", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const liveRoot = path.join(tempWorkspace, "live", "OctoClaw");
    const mirrorRoot = path.join(tempWorkspace, ".openclaw", "workspace", "openclaw", "repos", "octoclaw");
    fsSync.mkdirSync(liveRoot, { recursive: true });
    fsSync.mkdirSync(mirrorRoot, { recursive: true });
    envOverrides.octoclawRoot = liveRoot;
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      pluginConfig: { octoclawRoot: liveRoot, workspaceRoot: tempWorkspace, speculativePreload: true },
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-live-root";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await handlers.get("before_prompt_build")!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-live-root", agentId: "main", channelId: "slack", cwd: mirrorRoot },
    );

    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative.spawnArgs).toMatchObject({ cwd: liveRoot });
    policyState.clearState(key);
  });

  it("marks failed speculative standby spawn stale so dispatch can fall back", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-failed";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const beforeToolCall = handlers.get("before_tool_call");
    const afterToolCall = handlers.get("after_tool_call");
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-failed", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    const firstLabel = String(speculative.label);
    await beforeToolCall!(
      { toolName: "sessions_spawn", params: speculative.spawnArgs },
      { sessionKey: key, sessionId: "session-spec-preload-failed", agentId: "main" },
    );
    await afterToolCall!(
      {
        toolName: "sessions_spawn",
        params: speculative.spawnArgs,
        result: {
          status: "error",
          error: "child session patch failed: session file locked",
          childSessionKey: "agent:main:subagent:failed-standby",
        },
      },
      { sessionKey: key, sessionId: "session-spec-preload-failed", agentId: "main" },
    );

    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "stale",
      error: "child session patch failed: session file locked",
    });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_failed",
      sessionKey: key,
    }));
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-failed", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const retrySpeculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(retrySpeculative).toMatchObject({ status: "hinted" });
    expect(retrySpeculative.label).not.toBe(firstLabel);
    policyState.clearState(key);
  });

  it("records failed speculative standby even if the host rejects before before_tool_call marks it started", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-host-rejected";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await handlers.get("before_prompt_build")!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-host-rejected", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative).toMatchObject({ status: "hinted" });

    await handlers.get("after_tool_call")!(
      {
        toolName: "sessions_spawn",
        params: speculative.spawnArgs,
        result: {
          status: "error",
          error: "sessions_spawn(mode=\"session\") is only available on channels that expose thread bindings. This request is not running on a channel that can bind a subagent thread.",
        },
      },
      { sessionKey: key, sessionId: "session-spec-preload-host-rejected", agentId: "main" },
    );

    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "stale",
      error: expect.stringContaining("thread bindings"),
    });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_failed",
      sessionKey: key,
      error: expect.stringContaining("thread bindings"),
    }));
    policyState.clearState(key);
  });

  it("does not reinject speculative standby after the host reports thread bindings unavailable", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-threadbinding-missing";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      speculativePreload: {
        label: "octoclaw-speculative-threadbinding-missing",
        status: "stale",
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now() - 1_000,
        spawnArgs: {
          task: "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
          label: "octoclaw-speculative-threadbinding-missing",
          mode: "session",
          thread: true,
          context: "isolated",
          lightContext: true,
        },
        error: "sessions_spawn(mode=\"session\") is only available on channels that expose thread bindings. This request is not running on a channel that can bind a subagent thread.",
      },
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof policyState.setState>[1]);

    const projection = await handlers.get("before_prompt_build")!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-threadbinding-missing", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext || "").not.toContain("OCTOCLAW_SPECULATIVE_SPAWN_HINT");
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      label: "octoclaw-speculative-threadbinding-missing",
      status: "stale",
    });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_skipped",
      sessionKey: key,
      reason: "thread_binding_unavailable",
    }));
    policyState.clearState(key);
  });

  it("marks matching speculative standby aliases stale after a failed spawn", async () => {
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "1";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-failed-alias";
    const aliasKey = "runtime-session-spec-preload-failed-alias";
    const prompt = "用子 agent 做一次实现 review";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const beforeToolCall = handlers.get("before_tool_call");
    const afterToolCall = handlers.get("after_tool_call");
    await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: aliasKey, agentId: "main", channelId: "slack", cwd: tempWorkspace },
    );
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    await beforeToolCall!(
      { toolName: "sessions_spawn", params: speculative.spawnArgs },
      { sessionKey: key, sessionId: aliasKey, agentId: "main" },
    );
    const started = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    policyState.setState(aliasKey, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      speculativePreload: started,
      speculative_preload: started,
      createdAt: Date.now(),
      updatedAt: Date.now() + 1,
    } as unknown as Parameters<typeof policyState.setState>[1]);

    await afterToolCall!(
      {
        toolName: "sessions_spawn",
        params: speculative.spawnArgs,
        result: {
          status: "error",
          error: "sessions_spawn(mode=\"session\") is not available on this channel",
        },
      },
      { sessionKey: key, sessionId: aliasKey, agentId: "main" },
    );

    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "stale",
    });
    expect((policyState.getState(aliasKey) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({
      status: "stale",
    });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_failed",
      sessionKey: key,
      alias_count: 2,
    }));
    policyState.clearState(key);
    policyState.clearState(aliasKey);
  });

  it("can enable speculative preload from plugin config without a process env flag", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_SPECULATIVE_PRELOAD = "";
    const handlers = new Map<string, Function>();
    plugin.register({
      pluginConfig: { speculativePreload: true },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-config";
    const prompt = "请委派子 agent 做一次只读验收";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-config", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("OCTOCLAW_SPECULATIVE_SPAWN_HINT");
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative).toMatchObject({ status: "hinted" });

    const beforeToolCall = handlers.get("before_tool_call");
    const allowed = await beforeToolCall!(
      { toolName: "sessions_spawn", params: speculative.spawnArgs },
      { sessionKey: key, sessionId: "session-spec-preload-config", agentId: "main" },
    );
    expect(allowed).toBeUndefined();
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({ status: "spawn_call_started" });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_hint_injected",
      sessionKey: key,
    }));
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_allowed",
      sessionKey: key,
    }));
    policyState.clearState(key);
  });

  it("uses live runtime config for speculative preload hooks", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      pluginConfig: {},
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "octoclaw-runtime": {
                  config: { speculativePreload: true },
                },
              },
            },
          }),
        },
      },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-live-config";
    const prompt = "请委派子 agent 做一次只读验收";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-live-config", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("OCTOCLAW_SPECULATIVE_SPAWN_HINT");
    const speculative = (policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload as Record<string, unknown>;
    expect(speculative).toMatchObject({ status: "hinted" });

    const beforeToolCall = handlers.get("before_tool_call");
    const allowed = await beforeToolCall!(
      { toolName: "sessions_spawn", params: speculative.spawnArgs },
      { sessionKey: key, sessionId: "session-spec-preload-live-config", agentId: "main" },
    );
    expect(allowed).toBeUndefined();
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({ status: "spawn_call_started" });
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_hint_injected",
      sessionKey: key,
    }));
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "speculative_preload_spawn_allowed",
      sessionKey: key,
    }));
    policyState.clearState(key);
  });

  it("keeps api config speculative preload when live runtime config omits the rollout field", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      pluginConfig: {},
      config: {
        plugins: {
          entries: {
            "octoclaw-runtime": {
              config: { speculativePreload: true },
            },
          },
        },
      },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "octoclaw-runtime": {
                  config: { judgeFast: { enabled: true } },
                },
              },
            },
          }),
        },
      },
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-preload-merged-config";
    const prompt = "请委派子 agent 做一次只读验收";
    policyState.setState(key, {
      prompt,
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    const projection = await beforePromptBuild!(
      { prompt },
      { sessionKey: key, sessionId: "session-spec-preload-merged-config", agentId: "main", channelId: "slack", cwd: tempWorkspace },
    ) as { prependSystemContext?: string } | undefined;

    expect(projection?.prependSystemContext).toContain("OCTOCLAW_SPECULATIVE_SPAWN_HINT");
    expect((policyState.getState(key) as unknown as Record<string, unknown>)?.speculativePreload).toMatchObject({ status: "hinted" });
    policyState.clearState(key);
  });

  it("gates sessions_send through a pending send_to_speculative intent", async () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spec-send";
    const args = {
      label: "octoclaw-speculative-testsend",
      agentId: "main",
      message: "Run the actual delegated task.",
      timeoutSeconds: 0,
    };
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-speculative-send",
      sessionKey: key,
      sessionsSpawnArgs: args as unknown as { task: string; [key: string]: unknown },
      dispatchMode: "send_to_speculative",
      speculativeSessionLabel: "octoclaw-speculative-testsend",
      ttlMs: 60_000,
    });
    policyState.setState(key, {
      decision: budgetedMainDecision("delegate"),
      routeHintSubmitted: true,
      spawnIntentId: intent.spawnIntentId,
      workContractId: intent.workContractId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const allowed = await beforeToolCall!(
      { toolName: "sessions_send", params: { ...args, sessionKey: "" } },
      { sessionKey: key, sessionId: "session-spec-send", agentId: "main" },
    );

    expect(allowed).toBeUndefined();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
    await waitForFireAndForget();
    expect(readReplayEvents()).toContainEqual(expect.objectContaining({
      event: "sessions_send_intent_allowed",
      spawn_intent_id: intent.spawnIntentId,
      dispatch_mode: "send_to_speculative",
    }));
    policyState.clearState(key);
  });
});

describe("before_tool_call route hint guard", () => {


  it("does not block octoclaw_dispatch with the manual delegation pattern guard", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate", decision_bucket: "must_delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: {
          must_delegate_via: "octoclaw_dispatch",
          allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
          block_tool_patterns: ["sessions_spawn", "delegate"],
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "delegate with octoclaw_dispatch instead of sessions_spawn" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("allows native planner control tools before route_hint while still blocking ordinary tools", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: {
          must_delegate_via: "octoclaw_dispatch",
          allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
          block_tool_patterns: ["sessions_spawn", "delegate"],
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const confirmResult = await beforeToolCall!(
      {
        toolName: "octoclaw_dispatch_confirm",
        params: {
          spawnIntentId: "nsp_test",
          workContractId: "wc-test",
          sessionsSpawnStatus: "accepted",
          runId: "run-test",
        },
      },
      { sessionKey: key, agentId: "main" },
    );
    const ordinaryResult = await beforeToolCall!(
      { toolName: "read", params: { path: "README.md" } },
      { sessionKey: key, agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    const yieldResult = await beforeToolCall!(
      { toolName: "sessions_yield", params: { message: "等待委派子任务完成。" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(confirmResult).toBeUndefined();
    expect(yieldResult).toBeUndefined();
    expect(ordinaryResult?.block).toBe(true);
    expect(ordinaryResult?.blockReason).toContain("requires octoclaw_route_hint");
    policyState.clearState(key);
  });



  it("allows main-session direct tools after a sealed delegate route (coordinator prompt + delivery lock prevent conflicts)", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:default:direct:u0al9t5u89z:thread:t-sealed-delegate";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate", route_source: "judge" },
        work_contract: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: {
          must_delegate_via: "octoclaw_dispatch",
          allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
        },
      },
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "read", params: { path: "AGENTS.md" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });



  it("allows direct tools when tool policy says direct tools are allowed even if route alias is stale", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:default:direct:u0al9t5u89z:thread:t-stale";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "delegate", route_source: "stale_alias" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "write", params: { path: "docs/example.md" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("allows direct tools for a sealed reply route even when route_hint_required remains true", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-direct";
    policyState.setState(key, {
      decision: {
        route_decision: { route: "reply", route_source: "work_contract" },
        work_contract: { route: "reply", allowedTools: ["read", "write", "exec"] },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "read", params: { path: "docs/example.md" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(key);
  });

  it("uses the dispatch task policy context over a stale reply WorkContract", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const staleKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const delegateKey = "route-hint:openclaw-latest";
    const now = Date.now();
    policyState.setState(staleKey, {
      prompt: "刚才那个任务状态",
      decision: {
        route_decision: { route: "reply" },
        work_contract: { route: "reply", forbiddenTools: ["octoclaw_dispatch", "spawn"] },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: { allow_direct_tools: true },
      },
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    policyState.setState(delegateKey, {
      prompt: "查询 OpenClaw 最新版 release notes / changelog，总结新特性。",
      decision: {
        route_decision: { route: "delegate", route_source: "rule" },
        work_contract: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      routeHintSubmitted: true,
      createdAt: now,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "查询 OpenClaw 最新版 release notes / changelog，总结新特性。请给来源。" } },
      { sessionKey: staleKey, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(staleKey);
    policyState.clearState(delegateKey);
  });

  it("records WorkContract-forbidden dispatch attempts as blocked tool evidence", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:default:direct:u0al9t5u89z:work-contract-reply";
    policyState.setState(key, {
      prompt: "再试下",
      decision: {
        route_decision: { route: "reply" },
        work_contract: { route: "reply", forbiddenTools: ["octoclaw_dispatch"] },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: { allow_direct_tools: true },
      },
      blockedTools: ["sessions_spawn"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "octoclaw_dispatch", params: { task: "测试子 agent 派发耗时" } },
      { sessionKey: key, agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("WorkContract forbids octoclaw_dispatch");
    expect(policyState.getState(key)?.blockedTools).toEqual(["sessions_spawn", "octoclaw_dispatch"]);
    policyState.clearState(key);
  });

  it("binds octoclaw_route_hint task to the current Slack context before later tool calls", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:default:direct:u0al9t5u89z";
    const now = Date.now();
    policyState.setState(key, {
      prompt: "上一个委派任务",
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const hintResult = await beforeToolCall!(
      { toolName: "octoclaw_route_hint", params: { task: "查询北京五一假期天气", routeHint: "reply" } },
      { sessionKey: key, agentId: "main" },
    );
    expect(hintResult).toBeUndefined();
    expect(policyState.getState(key)?.prompt).toBe("查询北京五一假期天气");

    policyState.setState(key, {
      ...(policyState.getState(key) ?? {}),
      decision: {
        route_decision: { route: "reply" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: true },
        tool_policy: { allow_direct_tools: true },
      },
      routeHintSubmitted: true,
      updatedAt: Date.now(),
    });

    const toolResult = await beforeToolCall!(
      { toolName: "exec", params: { command: "curl -s wttr.in/Beijing" } },
      { sessionKey: key, agentId: "main" },
    );

    expect(toolResult).toBeUndefined();
    policyState.clearState(key);
  });

  it("does not block direct tools after a reply route_hint is stored on a newer context alias", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const oldKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const aliasKey = "session-route-hint-alias";
    const now = Date.now();
    policyState.setState(oldKey, {
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: false },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"] },
      },
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    policyState.setState(aliasKey, {
      decision: {
        route_decision: { route: "reply" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: true, route_hint_tool: "octoclaw_route_hint" } },
        route_hint_policy: { required: true, submitted: true },
        tool_policy: { allow_direct_tools: true },
      },
      routeHintSubmitted: true,
      createdAt: now,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "web_fetch", params: {} },
      { sessionKey: oldKey, sessionId: aliasKey, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(oldKey);
    policyState.clearState(aliasKey);
  });

  it("does not block normal tools when stale delegate state exists for a similar prompt", async () => {
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const staleKey = "route-hint:stale-openclaw-changelog";
    const currentKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const now = Date.now();
    policyState.setState(staleKey, {
      prompt: "查询 OpenClaw 最新版 release notes / changelog，总结新特性。",
      decision: {
        route_decision: { route: "delegate", route_source: "rule" },
        work_contract: { route: "delegate" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", block_tool_patterns: ["sessions_spawn", "delegate"], allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status"] },
      },
      routeHintSubmitted: true,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    });
    policyState.setState(currentKey, {
      decision: {
        route_decision: { route: "reply" },
        hook_interface: { before_tool_call: { enabled: true, route_hint_required: false, route_hint_tool: "octoclaw_route_hint", delegation_enforcement: true } },
        route_hint_policy: { required: false, submitted: false },
        tool_policy: { allow_direct_tools: true },
      },
      createdAt: now,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "read", params: { path: "docs/example.md" } },
      { sessionKey: currentKey, agentId: "main" },
    );

    expect(result).toBeUndefined();
    policyState.clearState(staleKey);
    policyState.clearState(currentKey);
  });

  it("blocks sessions_spawn when no pending planner intent exists", async () => {
    nativeSpawnIntentStore.clearForTests();
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spawn-gate-missing";
    policyState.setState(key, {
      decision: {
        request: { session_key: key },
        route_decision: { route: "delegate", decision_bucket: "must_delegate" },
        hook_interface: { before_tool_call: { enabled: false } },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    const result = await beforeToolCall!(
      { toolName: "sessions_spawn", params: { task: "do work", runtime: "subagent" } },
      { sessionKey: key, agentId: "main" },
    ) as { block?: boolean; blockReason?: string } | undefined;

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("no current pending native spawn intent");
    policyState.clearState(key);
    nativeSpawnIntentStore.clearForTests();
    delete process.env.OCTOCLAW_SPAWN_BACKEND;
  });

  it("still gates sessions_spawn when the general before_tool_call hook is disabled", async () => {
    nativeSpawnIntentStore.clearForTests();
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spawn-gate-hook-disabled";
    const args = { task: "do work", runtime: "subagent" as const, mode: "run" as const, cleanup: "keep" as const, sandbox: "inherit" as const, lightContext: true };
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-spawn-gate-hook-disabled",
      sessionKey: key,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    policyState.setState(key, {
      decision: {
        request: { session_key: key },
        route_decision: { route: "delegate", decision_bucket: "must_delegate" },
        hook_interface: { before_tool_call: { enabled: false } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status"] },
      },
      routeHintSubmitted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "sessions_spawn", params: args },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
    const replayLogPath = path.join(tempWorkspace, "tmp", "octopus", "runtime-policy-replay.jsonl");
    const events = fsSync.readFileSync(replayLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: string; spawn_intent_id?: string; work_contract_id?: string; decision_bucket?: string });
    expect(events).toContainEqual(expect.objectContaining({
      event: "sessions_spawn_intent_allowed",
      spawn_intent_id: intent.spawnIntentId,
      work_contract_id: intent.workContractId,
      decision_bucket: "must_delegate",
    }));
    policyState.clearState(key);
    nativeSpawnIntentStore.clearForTests();
    delete process.env.OCTOCLAW_SPAWN_BACKEND;
  });

  it("records budget escalation metrics when budgeted main reaches sessions_spawn gate", async () => {
    nativeSpawnIntentStore.clearForTests();
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const handlers = new Map<string, Function>();
    plugin.register({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: () => {},
      logger: {},
    });

    const key = "agent:main:slack:channel:c0as4dappu3:thread:t-spawn-gate-budgeted-main";
    const now = Date.now();
    const args = { task: "summarize current runtime evidence", runtime: "subagent" as const, mode: "run" as const, cleanup: "keep" as const, sandbox: "inherit" as const, lightContext: true };
    const intent = nativeSpawnIntentStore.create({
      workContractId: "wc-spawn-gate-budgeted-main",
      sessionKey: key,
      sessionsSpawnArgs: args,
      ttlMs: 60_000,
    });
    policyState.setState(key, {
      decision: {
        request: { session_key: key },
        route_decision: { route: "delegate", decision_bucket: "budgeted_main_then_delegate" },
        hook_interface: { before_tool_call: { enabled: false } },
        route_hint_policy: { required: false, submitted: true },
        tool_policy: { must_delegate_via: "octoclaw_dispatch", allowed_control_tools: ["octoclaw_dispatch", "octoclaw_status"] },
      },
      routeHintSubmitted: true,
      inboundObservedAt: now - 45_000,
      budgetedMain: budgetedMainState(now - 31_000, {
        reason: "wall_time_over_budget",
        escalatedPending: true,
        escalated_pending: true,
      }),
      budgeted_main: budgetedMainState(now - 31_000, {
        reason: "wall_time_over_budget",
        escalatedPending: true,
        escalated_pending: true,
      }),
      createdAt: now - 45_000,
      updatedAt: now,
    });

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTruthy();
    const result = await beforeToolCall!(
      { toolName: "sessions_spawn", params: args },
      { sessionKey: key, agentId: "main" },
    );

    expect(result).toBeUndefined();
    expect(nativeSpawnIntentStore.get(intent.spawnIntentId)?.status).toBe("spawn_call_started");
    await waitForFireAndForget();
    const events = readReplayEvents();
    expect(events).toContainEqual(expect.objectContaining({
      event: "budgeted_main_escalated",
      reason: "wall_time_over_budget",
      decision_bucket: "budgeted_main_then_delegate",
      budgetEscalationReason: "wall_time_over_budget",
      workContractId: intent.workContractId,
      spawnIntentId: intent.spawnIntentId,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "sessions_spawn_intent_allowed",
      spawn_intent_id: intent.spawnIntentId,
      work_contract_id: intent.workContractId,
      decision_bucket: "budgeted_main_then_delegate",
    }));
    expect(policyState.getState(key)?.budgetedMain).toMatchObject({
      active: false,
      reason: "wall_time_over_budget",
      workContractId: intent.workContractId,
      spawnIntentId: intent.spawnIntentId,
    });
    policyState.clearState(key);
    nativeSpawnIntentStore.clearForTests();
    delete process.env.OCTOCLAW_SPAWN_BACKEND;
  });
});
