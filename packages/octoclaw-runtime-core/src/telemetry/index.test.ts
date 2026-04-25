import { describe, expect, it } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { OptimizationTelemetry } from "@octoclaw/contracts/telemetry";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { normalizeRuntimeRequest } from "../requests/index.js";
import { buildRuntimeTaskInterface } from "../tasks/index.js";
import { buildCostSpeedBaselineReport, emitRuntimeTelemetry } from "./index.js";
import { startRuntimeWorkflow } from "../workflow/index.js";

function buildDecision(): PolicyDecision {
  return {
    route: "delegate",
    role: "worker_research",
    coordinationMode: "solo_worker",
    backend: "openclaw-native",
    executionProfile: "worker",
    workspaceMode: "isolated_worktree",
    modelProfile: "worker_research",
    caps: {
      queueBudget: 6,
      maxWorkers: 3,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "worker_research_single_worker_background_budget",
    },
    admission: {
      admission: "allow",
      queueBudget: 6,
      maxWorkers: 3,
      latencyTarget: "background",
      reason: "admission_allowed",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "isolated_worktree",
    readScope: [{ resource: "repo", access: "read" }],
    writeScope: [],
    writeScopeSummary: "",
  };
}

describe("runtime telemetry", () => {
  it("emits a valid telemetry bundle with request task and flow layers", () => {
    const request = normalizeRuntimeRequest({
      prompt: "emit telemetry",
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      metadata: { source: "test" },
    });
    const workflow = startRuntimeWorkflow({
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      decision: buildDecision(),
      role: "worker_research",
      claimOwner: "worker-a",
      leaseDurationMs: 30_000,
      deadlineBudget: {
        queuedAt: "2026-04-18T19:00:00.000Z",
        queueMs: 10_000,
        startMs: 20_000,
        progressMs: 30_000,
        runtimeMs: 40_000,
        deliveryMs: 50_000,
      },
      scope: buildScope(),
    });
    const taskState = buildRuntimeTaskInterface({
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      claimOwner: "worker-a",
      leaseDurationMs: 30_000,
      identity: workflow.identity,
      deadlineBudget: {
        queuedAt: "2026-04-18T19:00:00.000Z",
        queueMs: 10_000,
        startMs: 20_000,
        progressMs: 30_000,
        runtimeMs: 40_000,
        deliveryMs: 50_000,
      },
    });

    const telemetry = emitRuntimeTelemetry(request, workflow, taskState);

    expect(telemetry.request).toMatchObject({
      telemetryId: "policy:req-1",
      requestId: "req-1",
      selectedRoute: "delegate",
      selectedRole: "worker_research",
      backend: "openclaw-native",
      modelProfile: "worker_research",
    });
    expect(telemetry.request.reasonCodes).toContain("admission_allowed");

    expect(telemetry.task).toMatchObject({
      telemetryId: "task:flow-1:task-1",
      requestId: "req-1",
      route: "delegate",
      role: "worker_research",
      coordinationMode: "solo_worker",
      workspaceMode: "isolated_worktree",
      taskId: "task-1",
      flowId: "flow-1",
      queueBudget: 6,
      concurrencyBudget: 3,
      backend: "openclaw-native",
      modelProfile: "worker_research",
      queueDeadlineAt: "2026-04-18T19:00:10.000Z",
      startDeadlineAt: "2026-04-18T19:00:20.000Z",
      progressDeadlineAt: "2026-04-18T19:00:30.000Z",
      runtimeDeadlineAt: "2026-04-18T19:00:40.000Z",
      deliveryDeadlineAt: "2026-04-18T19:00:50.000Z",
    });

    expect(telemetry.flow).toMatchObject({
      telemetryId: "flow:flow-1:summary",
      taskId: "task-1",
      flowId: "flow-1",
    });
  });
});

describe("cost/speed baseline report", () => {
  it("groups telemetry by reply/delegate/flow lane with latency, cost, and context metrics", () => {
    const report = buildCostSpeedBaselineReport([
      {
        schemaVersion: "octoclaw.contracts/v1",
        createdAt: "2026-04-25T00:00:00.000Z",
        kind: "telemetry",
        telemetryId: "task:flow-1:reply-1",
        requestId: "req-1",
        taskId: "reply-1",
        flowId: "flow-1",
        route: "reply",
        role: "main_reply",
        modelProfile: "direct_main",
        backend: "openclaw-native",
        queueBudget: 1,
        concurrencyBudget: 1,
        capabilityBudget: ["reply"],
        workspaceMode: "read_only",
        readScope: [],
        writeScope: [],
        ackMs: 10,
        routeDecisionMs: 20,
        totalLatencyMs: 100,
        actualCostUsd: 0.01,
        estimatedCostUsd: 0.02,
        terminalState: "completed",
        parentContextTokensAdded: 5,
        resultPacketTokens: 8,
      },
      {
        schemaVersion: "octoclaw.contracts/v1",
        createdAt: "2026-04-25T00:00:01.000Z",
        kind: "telemetry",
        telemetryId: "task:flow-1:delegate-1",
        requestId: "req-2",
        taskId: "delegate-1",
        flowId: "flow-1",
        route: "delegate",
        role: "worker_code",
        modelProfile: "worker_code_normal",
        backend: "openclaw-native",
        queueBudget: 3,
        concurrencyBudget: 1,
        capabilityBudget: ["delegate"],
        workspaceMode: "isolated_worktree",
        readScope: [],
        writeScope: [],
        queueWaitMs: 30,
        firstProgressMs: 40,
        finalDeliveryMs: 50,
        totalLatencyMs: 200,
        actualCostUsd: 0.03,
        terminalState: "completed",
        fallbackCount: 1,
        retryCount: 2,
        parentContextTokensAdded: 10,
        resultPacketTokens: 20,
      },
      {
        schemaVersion: "octoclaw.contracts/v1",
        createdAt: "2026-04-25T00:00:02.000Z",
        kind: "telemetry",
        telemetryId: "flow:flow-1:summary",
        requestId: "req-3",
        taskId: "delegate-1",
        flowId: "flow-1",
        route: "delegate",
        role: "worker_code",
        modelProfile: "worker_code_normal",
        backend: "openclaw-native",
        queueBudget: 3,
        concurrencyBudget: 1,
        capabilityBudget: ["flow"],
        workspaceMode: "isolated_worktree",
        readScope: [],
        writeScope: [],
        totalLatencyMs: 250,
        actualCostUsd: 0.04,
        terminalState: "failed",
      },
    ], "2026-04-25T00:01:00.000Z");

    expect(report.generatedAt).toBe("2026-04-25T00:01:00.000Z");
    expect(report.lanes.find((lane) => lane.lane === "reply")).toMatchObject({
      requestCount: 1,
      successCount: 1,
      ackMs: { p50: 10, p95: 10, p99: 10 },
      actualCostUsd: 0.01,
      costPerSuccess: 0.01,
    });
    expect(report.lanes.find((lane) => lane.lane === "delegate")).toMatchObject({
      fallbackCount: 1,
      retryCount: 2,
      parentContextTokensAdded: { p50: 10, p95: 10, p99: 10 },
      resultPacketTokens: { p50: 20, p95: 20, p99: 20 },
    });
    expect(report.lanes.find((lane) => lane.lane === "flow")?.terminalStates.failed).toBe(1);
  });
});

function buildOptimizationTelemetry(overrides: Partial<OptimizationTelemetry> = {}): OptimizationTelemetry {
  const telemetryId = overrides.telemetryId ?? "task:flow-acceptance:task-acceptance";

  return {
    schemaVersion: "octoclaw.contracts/v1",
    kind: "telemetry",
    createdAt: "2026-04-25T00:00:00.000Z",
    telemetryId,
    requestId: "req-acceptance",
    taskId: "task-acceptance",
    flowId: "flow-acceptance",
    route: "reply",
    role: "main_reply",
    queueBudget: 1,
    concurrencyBudget: 1,
    capabilityBudget: ["reply"],
    modelProfile: "direct_main",
    backend: "openclaw-native",
    workspaceMode: "read_only",
    readScope: [],
    writeScope: [],
    writeScopeSummary: "",
    ...overrides,
  };
}

function lane(report: ReturnType<typeof buildCostSpeedBaselineReport>, laneName: "reply" | "delegate" | "flow") {
  const laneReport = report.lanes.find((item) => item.lane === laneName);
  expect(laneReport).toBeDefined();
  return laneReport!;
}

describe("Phase C acceptance: cost/speed baseline report", () => {
  it("computes per-lane request counts and success counts", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ requestId: "req-1", taskId: "reply-1", telemetryId: "task:flow-1:reply-1", route: "reply", terminalState: "completed" }),
      buildOptimizationTelemetry({ requestId: "req-2", taskId: "reply-2", telemetryId: "task:flow-1:reply-2", route: "reply", terminalState: "failed" }),
      buildOptimizationTelemetry({ requestId: "req-3", taskId: "reply-3", telemetryId: "task:flow-1:reply-3", route: "reply", terminalState: "success" }),
      buildOptimizationTelemetry({ requestId: "req-4", taskId: "delegate-1", telemetryId: "task:flow-1:delegate-1", route: "delegate", terminalState: "completed" }),
      buildOptimizationTelemetry({ requestId: "req-5", taskId: "delegate-2", telemetryId: "task:flow-1:delegate-2", route: "delegate", terminalState: "blocked" }),
    ]);

    expect(lane(report, "reply")).toMatchObject({ requestCount: 3, successCount: 2 });
    expect(lane(report, "delegate")).toMatchObject({ requestCount: 2, successCount: 1 });
    expect(lane(report, "flow")).toMatchObject({ requestCount: 0, successCount: 0 });
  });

  it("computes p50/p95/p99 for ack_ms, route_decision_ms, total_latency_ms", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-1", ackMs: 10, routeDecisionMs: 100, totalLatencyMs: 1_000 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-2", ackMs: 20, routeDecisionMs: 200, totalLatencyMs: 2_000 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-3", ackMs: 30, routeDecisionMs: 300, totalLatencyMs: 3_000 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-4", ackMs: 40, routeDecisionMs: 400, totalLatencyMs: 4_000 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-5", ackMs: 50, routeDecisionMs: 500, totalLatencyMs: 5_000 }),
    ]);

    expect(lane(report, "reply")).toMatchObject({
      ackMs: { p50: 30, p95: 50, p99: 50 },
      routeDecisionMs: { p50: 300, p95: 500, p99: 500 },
      totalLatencyMs: { p50: 3_000, p95: 5_000, p99: 5_000 },
    });
  });

  it("computes cost_per_request and cost_per_success", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:delegate-1", route: "delegate", actualCostUsd: 0.03, terminalState: "completed" }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:delegate-2", route: "delegate", actualCostUsd: 0.06, terminalState: "failed" }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:delegate-3", route: "delegate", actualCostUsd: 0.09, terminalState: "succeeded" }),
    ]);

    expect(lane(report, "delegate")).toMatchObject({
      requestCount: 3,
      successCount: 2,
      actualCostUsd: 0.18,
      costPerRequest: 0.06,
      costPerSuccess: 0.09,
    });
  });

  it("aggregates fallback_count, retry_count across lane", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:delegate-1", route: "delegate", fallbackCount: 1, retryCount: 2 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:delegate-2", route: "delegate", fallbackCount: 3, retryCount: 4 }),
    ]);

    expect(lane(report, "delegate")).toMatchObject({ fallbackCount: 4, retryCount: 6 });
  });

  it("computes terminal_state distribution", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-1", terminalState: "completed" }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-2", terminalState: "completed" }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-3", terminalState: "failed" }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-4", terminalState: "blocked" }),
    ]);

    expect(lane(report, "reply").terminalStates).toEqual({ completed: 2, failed: 1, blocked: 1 });
  });

  it("computes parent_context_tokens_added and result_packet_tokens summaries", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-1", parentContextTokensAdded: 5, resultPacketTokens: 50 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-2", parentContextTokensAdded: 10, resultPacketTokens: 100 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-3", parentContextTokensAdded: 15, resultPacketTokens: 150 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-4", parentContextTokensAdded: 20, resultPacketTokens: 200 }),
      buildOptimizationTelemetry({ telemetryId: "task:flow-1:reply-5", parentContextTokensAdded: 25, resultPacketTokens: 250 }),
    ]);

    expect(lane(report, "reply")).toMatchObject({
      parentContextTokensAdded: { p50: 15, p95: 25, p99: 25 },
      resultPacketTokens: { p50: 150, p95: 250, p99: 250 },
    });
  });

  it("empty telemetry produces zero-count lanes", () => {
    const report = buildCostSpeedBaselineReport([]);

    expect(report.lanes).toHaveLength(3);
    expect(lane(report, "reply").requestCount).toBe(0);
    expect(lane(report, "delegate").requestCount).toBe(0);
    expect(lane(report, "flow").requestCount).toBe(0);
  });

  it("flow lane identified by telemetryId prefix", () => {
    const report = buildCostSpeedBaselineReport([
      buildOptimizationTelemetry({ telemetryId: "flow:flow-1:summary", route: "delegate", terminalState: "completed" }),
    ]);

    expect(lane(report, "flow")).toMatchObject({ requestCount: 1, successCount: 1 });
    expect(lane(report, "delegate").requestCount).toBe(0);
  });
});
