import { describe, expect, it } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { startRuntimeWorkflow } from "../workflow/index.js";
import { buildFinalDelivery, buildProgressDelivery } from "./protocol.js";

function buildDecision(): PolicyDecision {
  return {
    route: "delegate.single",
    role: "worker_research",
    coordinationMode: "solo_worker",
    backend: "openclaw-native",
    executionProfile: "worker",
    workspaceMode: "isolated_worktree",
    modelProfile: "worker_research",
    caps: {
      queueBudget: 2,
      maxWorkers: 1,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "worker_research_single_worker_background_budget",
    },
    admission: {
      admission: "allow",
      queueBudget: 2,
      maxWorkers: 1,
      latencyTarget: "background",
      reason: "admission_allowed",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "isolated_worktree",
    readScope: [],
    writeScope: [],
    writeScopeSummary: "",
  };
}

function buildWorkflow() {
  return startRuntimeWorkflow({
    requestId: "req-1",
    taskId: "task-1",
    flowId: "flow-1",
    decision: buildDecision(),
    role: "worker_research",
    claimOwner: "worker-a",
    leaseDurationMs: 30_000,
    deadlineBudget: {
      queuedAt: "2026-04-18T16:00:00.000Z",
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 3_000,
      runtimeMs: 4_000,
      deliveryMs: 5_000,
    },
    scope: buildScope(),
  });
}

describe("delivery protocol", () => {
  it("builds structured progress deliveries", () => {
    const delivery = buildProgressDelivery(buildWorkflow(), {
      channel: "slack",
      summary: "checkpoint emitted",
      detail: "details",
      artifactRefs: ["artifact-1"],
      queuedAt: "2026-04-18T16:00:10.000Z",
    });

    expect(delivery.envelope).toMatchObject({
      deliveryId: "delivery:flow-1:task-1:checkpoint:pending",
      deliveryReceiptId: "receipt:flow-1:task-1:checkpoint:pending",
      outboxId: "outbox:flow-1:task-1:checkpoint:pending",
      status: "queued",
      channel: "slack",
      queuedAt: "2026-04-18T16:00:10.000Z",
      taskId: "task-1",
      flowId: "flow-1",
    });
    expect(delivery.payload).toEqual({
      protocolVersion: "octoclaw.runtime_delivery/v1",
      kind: "progress",
      summary: "checkpoint emitted",
      detail: "details",
      artifactRefs: ["artifact-1"],
      checkpointState: "none",
      deliverableReady: false,
      workflowPhase: "materialization_pending",
    });
  });

  it("builds final deliveries", () => {
    const delivery = buildFinalDelivery(buildWorkflow(), {
      channel: "email",
      summary: "workflow complete",
    });

    expect(delivery.envelope.deliveryId).toBe("delivery:flow-1:task-1:final");
    expect(delivery.payload.kind).toBe("final");
    expect(delivery.payload.summary).toBe("workflow complete");
  });

  it("defaults missing channel to direct", () => {
    const delivery = buildProgressDelivery(buildWorkflow(), {
      channel: "   ",
      summary: "default channel",
    });

    expect(delivery.envelope.channel).toBe("direct");
  });
});
