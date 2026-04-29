import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import {
  advanceWorkflowToRunning,
  markWorkflowCheckpointEmitted,
  markWorkflowCompleted,
  markWorkflowDeliverableReady,
  markWorkflowFailed,
  markWorkflowTimedOut,
  renewWorkflowHeartbeat,
  startRuntimeWorkflow,
} from "./index.js";

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
      queueBudget: 4,
      maxWorkers: 2,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "worker_research_single_worker_background_budget",
    },
    admission: {
      admission: "allow",
      queueBudget: 4,
      maxWorkers: 2,
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
      queuedAt: "2026-04-18T15:00:00.000Z",
      queueMs: 10_000,
      startMs: 20_000,
      progressMs: 30_000,
      runtimeMs: 40_000,
      deliveryMs: 50_000,
    },
    scope: buildScope(),
  });
}

describe("runtime workflow state machine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with a valid initial state", () => {
    const state = buildWorkflow();

    expect(state.ingressOrchestration).toBe("accepted");
    expect(state.workflowOrchestration).toBe("planned");
    expect(state.lifecycle.phase).toBe("materialization_pending");
    expect(state.claim?.claimOwner).toBe("worker-a");
    expect(state.outbox.entries).toEqual({});
    expect(state.ackLedger.receipts).toEqual({});
  });

  it("advances to running and sets startedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T15:00:05.000Z"));

    const running = advanceWorkflowToRunning(buildWorkflow(), "worker-a");

    expect(running.workflowOrchestration).toBe("running");
    expect(running.lifecycle.phase).toBe("running");
    expect(running.lifecycle.startedAt).toBe("2026-04-18T15:00:05.000Z");
  });

  it("marks checkpoint emission", () => {
    const checkpointed = markWorkflowCheckpointEmitted(buildWorkflow(), "2026-04-18T15:00:10.000Z");

    expect(checkpointed.checkpoints).toEqual({
      checkpointState: "emitted",
      lastCheckpointAt: "2026-04-18T15:00:10.000Z",
      deliverableReady: false,
    });
    expect(checkpointed.lifecycle.phase).toBe("checkpoint_emitted");
  });

  it("marks deliverable readiness", () => {
    const ready = markWorkflowDeliverableReady(buildWorkflow());

    expect(ready.checkpoints.deliverableReady).toBe(true);
    expect(ready.lifecycle.phase).toBe("deliverable_ready");
    expect(ready.lifecycle.deliveryState).toBe("queued");
  });

  it("marks completed state as terminal", () => {
    const completed = markWorkflowCompleted(buildWorkflow(), "2026-04-18T15:00:30.000Z");

    expect(completed.workflowOrchestration).toBe("completed");
    expect(completed.lifecycle.phase).toBe("completed");
    expect(completed.lifecycle.completedAt).toBe("2026-04-18T15:00:30.000Z");
  });

  it("marks failed state", () => {
    const failed = markWorkflowFailed(buildWorkflow(), "2026-04-18T15:00:31.000Z");

    expect(failed.workflowOrchestration).toBe("failed");
    expect(failed.lifecycle.phase).toBe("failed");
    expect(failed.lifecycle.failedAt).toBe("2026-04-18T15:00:31.000Z");
  });

  it("marks timeout as timed_out with emitted checkpoint metadata", () => {
    const timedOut = markWorkflowTimedOut(
      buildWorkflow(),
      "2026-04-18T15:00:32.000Z",
      "2026-04-18T15:00:32.000Z",
    );

    expect(timedOut.workflowOrchestration).toBe("failed");
    expect(timedOut.lifecycle.phase).toBe("timed_out");
    expect(timedOut.lifecycle.checkpointState).toBe("emitted");
    expect(timedOut.lifecycle.lastCheckpointAt).toBe("2026-04-18T15:00:32.000Z");
    expect(timedOut.lifecycle.failedAt).toBe("2026-04-18T15:00:32.000Z");
  });

  it("renews workflow heartbeat", () => {
    const state = buildWorkflow();
    const renewed = renewWorkflowHeartbeat(state, "2026-04-18T15:00:20.000Z");

    expect(renewed.claim?.lastHeartbeatAt).toBe("2026-04-18T15:00:20.000Z");
    expect(renewed.taskMaterialization.leaseExpiresAt).toBe(renewed.claim?.leaseExpiresAt);
  });

  it("rejects invalid claim-owner transitions while lease is active", () => {
    expect(() => advanceWorkflowToRunning(buildWorkflow(), "worker-b")).toThrow("claim_owner_conflict");
  });
});
