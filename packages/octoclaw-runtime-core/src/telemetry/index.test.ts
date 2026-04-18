import { describe, expect, it } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { normalizeRuntimeRequest } from "../requests/index.js";
import { buildRuntimeTaskInterface } from "../tasks/index.js";
import { emitRuntimeTelemetry } from "./index.js";
import { startRuntimeWorkflow } from "../workflow/index.js";

function buildDecision(): PolicyDecision {
  return {
    route: "delegate.single",
    role: "worker_research",
    backend: "worker",
    workspaceMode: "isolated_workspace",
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
    decisionStack: ["route", "role", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "isolated_workspace",
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
      selectedRoute: "delegate.single",
      selectedRole: "worker_research",
      backend: "openclaw-native",
      modelProfile: "worker_research",
    });
    expect(telemetry.request.reasonCodes).toContain("admission_allowed");

    expect(telemetry.task).toMatchObject({
      telemetryId: "task:flow-1:task-1",
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
