import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JudgeExecutionLayer, JudgeMemoryLayer } from "@octoclaw/policy/judge";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "./memory-coverage-precheck.js";
import type { WorkContract, NativeBindingRef, ContextCoverageSnapshot, CoverageAuthority } from "@octoclaw/contracts/work-contract";
import { compactWorkContractView } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { buildPolicyResolvedReplayPayload } from "../replay/replay.js";
import { authoritativeDecisionRoute, canonicalizeDecisionForPolicyState } from "./route-helpers.js";
import { resolveStatelessPolicyDecision } from "./policy-resolver.js";
import type { PolicyStateEntry } from "../state/policy-state.js";
import { policyState } from "../state/policy-state.js";

const now = new Date("2026-04-25T12:00:00.000Z");

function clearPolicyState(): void {
  for (const { key } of policyState.entries()) {
    policyState.clear(key);
  }
}

function seedPolicyStateEntry(
  key: string,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  policyState.set(key, {
    decision: {
      route_decision: { route: "reply" },
    },
    canonicalSessionKey: key,
    toolsUsed: ["web_fetch"],
    delegated: false,
    dispatchExecuted: false,
    ...overrides,
  });
}

function seedAt(
  key: string,
  completedAt: number,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  vi.setSystemTime(completedAt);
  seedPolicyStateEntry(key, overrides);
  vi.setSystemTime(now);
}

function hasExecutionCoverage(layer: JudgeExecutionLayer): boolean {
  return layer.coverage !== undefined && layer.coverage !== "none";
}

function hasMemoryCoverage(layer: JudgeMemoryLayer): boolean {
  return layer.coverage !== undefined && layer.coverage !== "none";
}

function buildCoverageSnapshot(
  execution: JudgeExecutionLayer,
  memory: JudgeMemoryLayer,
): ContextCoverageSnapshot {
  const executionCovered = hasExecutionCoverage(execution);
  const memoryCovered = hasMemoryCoverage(memory);
  const conflict = executionCovered && memoryCovered;
  const authority: CoverageAuthority = conflict && executionCovered
    ? "execution_wins"
    : memoryCovered
      ? "memory_only"
      : "none";

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
    conflict,
    authority,
  };
}

function routeForProvenanceFollowup(layer: JudgeExecutionLayer): "reply" | "delegate" {
  return layer.supports_provenance_reply === true ? "reply" : "delegate";
}

function forbiddenToolsForReply(layer: JudgeExecutionLayer): string[] {
  return routeForProvenanceFollowup(layer) === "reply" ? ["octoclaw_dispatch"] : [];
}

function preferredChildSessionKey(contract: WorkContract): string | undefined {
  return contract.delegate?.childSessions.find((child: NonNullable<WorkContract["delegate"]>["childSessions"][number]) => child.reuseState === "preferred")?.childSessionKey;
}

function nextActionForNativeBinding(binding: NativeBindingRef): "dispatch" | "wait" | "status_only" {
  return binding.lastMutationError === "revision_conflict" ? "wait" : "dispatch";
}

describe("WorkContract coverage acceptance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
  });

  it("provenance follow-up after reply+toolsUsed should not spawn", () => {
    const key = "agent:main:slack:default:direct:U12345";
    seedAt(key, Date.now() - 5_000, {
      decision: {
        route_decision: { route: "reply" },
      },
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });

    const layer = buildExecutionCoverageLayer([key]);
    const forbiddenTools = forbiddenToolsForReply(layer);

    expect(layer.supports_provenance_reply).toBe(true);
    expect(routeForProvenanceFollowup(layer)).toBe("reply");
    expect(routeForProvenanceFollowup(layer)).not.toBe("delegate");
    expect(forbiddenTools).toContain("octoclaw_dispatch");
    expect(forbiddenTools).not.toContain("octoclaw_spawn");
  });

  it("provenance follow-up after delegate+dispatchExecuted+spawnExecuted+resultMaterialized should cite worker", () => {
    const key = "agent:main:slack:default:direct:U22222";
    seedAt(key, Date.now() - 5_000, {
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
        delivery: { result_path: "/tmp/octoclaw/result.md", status: "delivered" },
      },
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: true,
      delegateTaskContext: {
        delegateTaskId: "task-worker-001",
        taskStatus: "completed",
      },
    });

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.supports_status_reply).toBe(true);
    expect(layer.spawn_executed).toBe(true);
    expect(layer.result_materialized).toBe(true);
    expect(layer.evidence_summary).toContain("worker=octoclaw-worker");
  });

  it("dispatchExecuted=true but spawnExecuted=false must answer honestly", () => {
    const key = "agent:main:slack:default:direct:U33333";
    seedAt(key, Date.now() - 5_000, {
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
        runtime_truth: {
          nativeTaskBinding: { nativeTaskId: "task-123" },
        },
      },
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: false,
      delegateTaskContext: {
        delegateTaskId: "task-dispatched-001",
        taskStatus: "active",
      },
    });

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.dispatch_executed).toBe(true);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.result_materialized).toBe(false);
    expect(layer.native_task_id).toBe("task-123");
    expect(layer.evidence_summary).toContain("dispatch was executed");
    expect(layer.evidence_summary).toContain("native_task=task-123");
  });

  it("execution coverage wins over memory coverage", () => {
    const key = "agent:main:slack:default:direct:U44444";
    seedAt(key, Date.now() - 120_000, {
      decision: {
        route_decision: { route: "reply" },
      },
      toolsUsed: [],
      delegated: false,
      dispatchExecuted: false,
    });
    const execution = buildExecutionCoverageLayer([key]);
    const memory: JudgeMemoryLayer = {
      ...buildMemoryCoverageLayer(),
      coverage: "strong",
      freshness_risk: "low",
      supports_direct_reply: true,
    };

    const snapshot = buildCoverageSnapshot(execution, memory);

    expect(execution.coverage).toBe("recent_turn");
    expect(execution.dispatch_executed).toBe(false);
    expect(memory.coverage).toBe("strong");
    expect(snapshot.conflict).toBe(true);
    expect(snapshot.authority).toBe("execution_wins");
  });

  it("same delegate task follow-up prefers resume_preferred", () => {
    const coverage = buildCoverageSnapshot(buildExecutionCoverageLayer(["missing"]), buildMemoryCoverageLayer());
    const contract: WorkContract = {
      schemaVersion: "octoclaw.work_contract.v1",
      workContractId: "wc-preferred-child",
      turnId: "turn-preferred-child",
      sessionKey: "agent:main:slack:default:direct:U55555",
      userAsk: "continue the delegated task",
      intentClass: "execution_followup",
      route: "delegate",
      status: "running",
      coverage,
      decision: {
        source: "continuation",
        route: "delegate",
        delegateRole: "code",
        reasonCodes: ["same_delegate_task"],
        sealedAt: now.toISOString(),
      },
      delegate: {
        delegateTaskId: "delegate-task-555",
        currentAttemptId: "attempt-2",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: ["reuse existing worker context"],
        scope: {
          read: ["extensions/octoclaw-runtime"],
          write: [],
          workspaceMode: "read_only",
          scopeFingerprint: "scope-555",
        },
        modelProfile: "coding",
        nativeBinding: null,
        childSessions: [
          {
            childSessionKey: "child-retired",
            delegateTaskId: "delegate-task-555",
            firstAttemptId: "attempt-1",
            latestAttemptId: "attempt-1",
            agentRole: "code",
            modelProfile: "coding",
            parentSessionKey: "agent:main:slack:default:direct:U55555",
            threadBindingKey: "thread-555",
            scopeFingerprint: "scope-555",
            status: "retired",
            reuseState: "retired",
          },
          {
            childSessionKey: "child-preferred",
            childSessionId: "provider-session-preferred",
            runId: "run-preferred",
            delegateTaskId: "delegate-task-555",
            firstAttemptId: "attempt-2",
            latestAttemptId: "attempt-2",
            agentRole: "code",
            modelProfile: "coding",
            parentSessionKey: "agent:main:slack:default:direct:U55555",
            threadBindingKey: "thread-555",
            scopeFingerprint: "scope-555",
            status: "idle",
            reuseState: "preferred",
          },
        ],
        artifactRefs: [],
        nextAction: "wait",
      },
      continuity: {
        threadBindingKey: "thread-555",
        parentSessionKey: "agent:main:slack:default:direct:U55555",
        preferredChildSessionKey: "child-preferred",
        preferredChildSessionId: "provider-session-preferred",
        preferredRunId: "run-preferred",
        continuationMode: "resume_preferred",
        delegateTaskId: "delegate-task-555",
      },
      mainContext: {
        summary: "continue delegated task",
        statusLine: "resume preferred child",
        visibleIds: {
          workContractId: "wc-preferred-child",
          delegateTaskId: "delegate-task-555",
          childSessionKey: "child-preferred",
          childSessionId: "provider-session-preferred",
        },
        continuationHint: {
          handle: "child-preferred",
          preferredMode: "resume_preferred",
          text: "resume_dont_restart",
        },
        artifactRefs: [],
        nextAction: "wait",
        tokenBudget: {
          maxResumeTokens: 700,
          maxArtifactSummaryTokens: 250,
        },
        forbiddenContent: ["full_transcript", "worker_chain_of_thought"],
      },
      telemetry: {
        authority: coverage.authority,
        childSessionKey: "child-preferred",
        childSessionId: "provider-session-preferred",
        childRunId: "run-preferred",
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const view = compactWorkContractView(contract);

    expect(contract.continuity.continuationMode).toBe("resume_preferred");
    expect(preferredChildSessionKey(contract)).toBe("child-preferred");
    expect(contract.continuity.preferredChildSessionKey).toBe("child-preferred");
    expect(view.delegateTaskId).toBe("delegate-task-555");
  });

  it("revision_conflict should not double-dispatch", () => {
    const binding: NativeBindingRef = {
      flowId: "flow-conflict-001",
      ownerKey: "octoclaw.delegate:delegate-task-666",
      controllerId: "octoclaw.delegate",
      revision: 4,
      expectedRevision: 3,
      taskId: "delegate-task-666",
      nativeTaskId: "native-task-666",
      syncMode: "managed",
      status: "running",
      lastMutation: "runTask",
      lastMutationApplied: false,
      lastMutationError: "revision_conflict",
    };

    expect(binding.lastMutationError).toBe("revision_conflict");
    expect(nextActionForNativeBinding(binding)).not.toBe("dispatch");
    expect(["wait", "status_only"]).toContain(nextActionForNativeBinding(binding));
  });

  it("flow created but no TaskRun evidence: honest spawnExecuted=false", () => {
    const key = "agent:main:slack:default:direct:U77777";
    seedAt(key, Date.now() - 5_000, {
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
        runtime_truth: {
          binding: { flowId: "flow-created-only" },
        },
      },
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: {
        delegateTaskId: "task-flow-only",
        taskStatus: "active",
      },
    });

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.dispatch_executed).toBe(true);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.result_materialized).toBe(false);
    expect(layer.native_task_id).toBeUndefined();
    expect(layer.native_flow_id).toBe("flow-created-only");
  });

  it("buildJudgeContextPacket includes memory coverage layer", async () => {
    const { buildJudgeContextPacket } = await import("./judge-context-packet.js");
    const packet = buildJudgeContextPacket({
      prompt: "test",
      sessionKeys: ["agent:main:test"],
      metadata: {},
    });
    expect(packet.memory).toBeDefined();
    expect(packet.memory?.coverage).toBe("none");
    expect(packet.execution).toBeDefined();
  });
});

describe("WP3 acceptance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("authoritativeDecisionRoute prefers WorkContract route over legacy", () => {
    const decision = {
      route_decision: { route: "reply" },
      work_contract: { route: "delegate" },
    };

    expect(authoritativeDecisionRoute(decision)).toBe("delegate");
  });

  it("legacy route fields match WorkContract route after canonicalize", () => {
    const decision = canonicalizeDecisionForPolicyState({
      work_contract: { route: "delegate" },
      route_decision: { route: "reply" },
      router_decision_v2: { request_kind: "reply" },
      tool_policy: { delegate_first: false },
    });

    expect((decision.route_decision as Record<string, unknown>).route).toBe("delegate");
    expect((decision.router_decision_v2 as Record<string, unknown>).request_kind).toBe("delegated_task");
    expect((decision.tool_policy as Record<string, unknown>).delegate_first).toBe(true);
  });

  it("does not infer authoritative route from router_decision_v2 alone", () => {
    const decision = {
      router_decision_v2: { request_kind: "delegated_task" },
      route_decision: { route: "reply" },
    };

    expect(authoritativeDecisionRoute(decision, "reply")).toBe("reply");
  });

  it("WorkContract telemetry includes memoryCoverage and decisionSource", () => {
    const execution = buildExecutionCoverageLayer(["missing"]);
    const memory: JudgeMemoryLayer = {
      ...buildMemoryCoverageLayer(),
      coverage: "strong",
      freshness_risk: "low",
    };
    const coverage = buildCoverageSnapshot(execution, memory);
    const seal = buildWorkDecisionSeal("local_judge", "reply", ["test_reason"]);

    const contract = buildWorkContractFromPolicy(
      "agent:main:wp3-telemetry",
      "hello",
      "plain_chat",
      coverage,
      seal,
    );

    expect(contract.telemetry.memoryCoverage).toBeDefined();
    expect(contract.telemetry.memoryCoverage).toBe("strong");
    expect(contract.telemetry.decisionSource).toBe(seal.source);
    expect(contract.telemetry.parentContextTokensAdded).toBe(0);
  });

  it("replay payload includes workContractId and decisionSource", () => {
    const payload = buildPolicyResolvedReplayPayload({
      decision: {
        route_decision: { route: "reply" },
        work_contract: { route: "reply", decisionSource: "local_judge" },
      },
      workContractId: "wc-wp3-replay",
      decisionSource: "local_judge",
    });

    expect(payload.workContractId).toBe("wc-wp3-replay");
    expect(payload.decisionSource).toBe("local_judge");
  });

  it("replay payload includes delegation ticket dry-run evidence", () => {
    const payload = buildPolicyResolvedReplayPayload({
      decision: {
        route_decision: { route: "delegate" },
        work_contract: { route: "delegate", decisionSource: "local_judge" },
        delegation_ticket_candidate: {
          ticket_decision: "ticket_would_issue",
          ticket_denial_reason: "",
          is_new_work: true,
          expected_deliverable: "modify runtime ledger",
        },
      },
      workContractId: "wc-ticket-replay",
      decisionSource: "local_judge",
    });

    expect(payload.ticket_decision).toBe("ticket_would_issue");
    expect(payload.ticket_denial_reason).toBe("");
    expect(payload.is_new_work).toBe(true);
    expect(payload.expected_deliverable).toBe("modify runtime ledger");
  });

  it("delegate decision still dispatches route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "delegate",
              confidence: 0.9,
              complexity: "normal",
              complexity_confidence: 0.74,
              abstain_reason: null,
              ack_text: "收到",
            }),
          },
        }],
      }),
    } as Response);

    const decision = await resolveStatelessPolicyDecision("请检查当前服务健康状态", {
      metadata: {
        _judgeFastConfig: {
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
        session_key: "agent:main:wp3-delegate",
        conversation_control: {
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          require_fresh_lookup: true,
        },
      },
    });

    expect((decision.route_decision as Record<string, unknown>).route).toBe("delegate");
    expect((decision.work_contract as Record<string, unknown>).route).toBe("delegate");
    expect((decision.work_contract as Record<string, unknown>).nextAction).toBe("dispatch");
  });

  it("reply decision still answers route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              route: "reply",
              confidence: 0.9,
              complexity: "simple",
              complexity_confidence: 0.74,
              abstain_reason: null,
              ack_text: "收到",
            }),
          },
        }],
      }),
    } as Response);

    const decision = await resolveStatelessPolicyDecision("hello", {
      metadata: {
        _judgeFastConfig: {
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
        session_key: "agent:main:wp3-reply",
        conversation_control: {
          intent_class: "plain_chat",
          route_hint: "reply",
        },
      },
    });

    expect((decision.route_decision as Record<string, unknown>).route).toBe("reply");
    expect((decision.work_contract as Record<string, unknown>).route).toBe("reply");
  });

  it("status/provenance follow-up with execution coverage seals WorkContract from execution_coverage as reply.answer", async () => {
    const stateKey = "agent:main:wp3-followup-covered";
    seedAt(stateKey, Date.now() - 5_000, {
      decision: { route_decision: { route: "delegate", worker_pool: "octoclaw-worker" } },
      canonicalSessionKey: stateKey,
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: false,
      delegateTaskContext: { delegateTaskId: "delegate-covered", taskStatus: "running" },
    });

    const decision = await resolveStatelessPolicyDecision("刚才那个任务判定是啥", {
      metadata: {
        _judgeFastConfig: {
          enabled: false,
          shadowMode: true,
          modelId: "test-local-judge",
          baseUrl: "",
          apiKey: "",
          timeoutMs: 1,
        },
        session_key: stateKey,
        conversation_control: {
          intent_class: "execution_followup",
          status_followup: true,
        },
      },
    });

    expect((decision.route_decision as Record<string, unknown>).route).toBe("reply");
    expect(decision.work_contract).toMatchObject({
      route: "reply",
      decisionSource: "execution_coverage",
      replyMode: "answer",
    });
    expect(decision._execution_coverage_packet).toMatchObject({
      route: "reply",
      replyMode: "answer",
      dispatchExecuted: true,
      spawnExecuted: false,
    });
    expect((decision.router_decision_v2 as Record<string, unknown>).compatibility_view).toBe(true);
  });
});
