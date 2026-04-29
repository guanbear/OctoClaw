import { describe, expect, it } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { applyRecoveryHook, assessRecoveryNeed } from "./index.js";
import type { RuntimeWorkflowState } from "../workflow/index.js";
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
      queueBudget: 3,
      maxWorkers: 1,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "worker_research_single_worker_background_budget",
    },
    admission: {
      admission: "allow",
      queueBudget: 3,
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
  const state = startRuntimeWorkflow({
    requestId: "req-1",
    taskId: "task-1",
    flowId: "flow-1",
    decision: buildDecision(),
    role: "worker_research",
    claimOwner: "worker-a",
    leaseDurationMs: 30_000,
    deadlineBudget: {
      queuedAt: "2026-04-18T18:00:00.000Z",
      queueMs: 10_000,
      startMs: 20_000,
      progressMs: 30_000,
      runtimeMs: 40_000,
      deliveryMs: 50_000,
    },
    scope: buildScope(),
  });

  return {
    ...state,
    claim: state.claim
      ? {
        ...state.claim,
        leaseExpiresAt: "2999-01-01T00:00:00.000Z",
      }
      : null,
  };
}

describe("recovery hooks", () => {
  it("reports healthy workflows as not requiring recovery", () => {
    expect(assessRecoveryNeed(buildWorkflow(), new Date("2026-04-18T18:00:05.000Z"))).toEqual({
      required: false,
      trigger: null,
      timedOut: false,
      deadlineField: null,
      reason: "workflow_healthy",
    });
  });

  it("detects expired queue deadlines", () => {
    const state = buildWorkflow();
    const assessed = assessRecoveryNeed(state, new Date("2026-04-18T18:00:11.000Z"));

    expect(assessed.trigger).toBe("queue_deadline_exceeded");
    expect(assessed.deadlineField).toBe("queueDeadline");
  });

  it("detects expired progress deadlines while running", () => {
    const workflow = buildWorkflow();
    const state: RuntimeWorkflowState = {
      ...workflow,
      lifecycle: {
        ...workflow.lifecycle,
        phase: "running" as const,
      },
    };
    const assessed = assessRecoveryNeed(state, new Date("2026-04-18T18:00:31.000Z"));

    expect(assessed.trigger).toBe("progress_deadline_exceeded");
    expect(assessed.deadlineField).toBe("progressDeadline");
  });

  it("detects expired leases", () => {
    const workflow = buildWorkflow();
    const state = {
      ...workflow,
      claim: {
        ...workflow.claim!,
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      },
    };
    const assessed = assessRecoveryNeed(state, new Date("2026-04-18T18:00:00.000Z"));

    expect(assessed.trigger).toBe("lease_expired");
    expect(assessed.timedOut).toBe(false);
  });

  it("marks timed-out workflows as timed_out when recovery fires on deadlines", () => {
    const recovered = applyRecoveryHook(buildWorkflow(), new Date("2026-04-18T18:00:11.000Z"));

    expect(recovered.workflowOrchestration).toBe("failed");
    expect(recovered.lifecycle.phase).toBe("timed_out");
    expect(recovered.lifecycle.failedAt).toBe("2026-04-18T18:00:11.000Z");
  });

  it("keeps healthy workflows unchanged", () => {
    const state = buildWorkflow();
    expect(applyRecoveryHook(state, new Date("2026-04-18T18:00:05.000Z"))).toEqual(state);
  });
});
