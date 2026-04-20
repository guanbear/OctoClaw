import { describe, expect, it } from "vitest";
import {
  type DelegateTask,
  type DelegateAttempt,
  type NativeTaskBinding,
  type AttemptStatus,
  type DelegateTaskStatus,
  type DelegateProgressEvent,
  type ResumePacket,
  type StatusQueryPacket,
  type RecoveryInfo,
  type FailureInfo,
  type CoordinationMode,
  type TimeoutCategory,
  type RecoveryCategory,
} from "./delegate.js";
import { OCTOCLAW_CONTRACT_SCHEMA_VERSION, buildContractEnvelope } from "./schemas.js";

describe("delegate contracts", () => {
  it("CoordinationMode accepts solo_worker", () => {
    const mode: CoordinationMode = "solo_worker";
    expect(mode).toBe("solo_worker");
  });

  it("AttemptStatus covers all lifecycle phases", () => {
    const statuses: AttemptStatus[] = [
      "pending", "queued", "running", "checkpoint", "deliverable_ready",
      "waiting_input", "completed", "failed", "timed_out", "recovering", "cancelled",
    ];
    expect(statuses).toHaveLength(11);
  });

  it("DelegateTaskStatus covers task-level projection", () => {
    const statuses: DelegateTaskStatus[] = [
      "pending", "active", "completed", "failed", "timed_out", "recovering", "cancelled",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("NativeTaskBinding maps delegate to native", () => {
    const binding: NativeTaskBinding = {
      delegateTaskId: "dt-1",
      attemptId: "att-1",
      nativeFlowId: "flow-uuid",
      nativeTaskId: "task-uuid",
      claimOwner: "octoclaw-runtime",
      resumeGeneration: 1,
    };
    expect(binding.delegateTaskId).toBe("dt-1");
    expect(binding.resumeGeneration).toBe(1);
  });

  it("DelegateTask has required fields with nullable currentAttemptId", () => {
    const task: DelegateTask = {
      ...buildContractEnvelope("projection"),
      kind: "projection",
      delegateTaskId: "dt-1",
      sessionId: "session-1",
      route: "delegate",
      role: "worker_research",
      coordinationMode: "solo_worker",
      goal: "research openclaw versions",
      status: "pending",
      currentAttemptId: null,
      totalAttempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      readScope: [],
      writeScope: [],
      workspaceMode: "isolated_worktree",
    };
    expect(task.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
    expect(task.currentAttemptId).toBeNull();
    expect(task.route).toBe("delegate");
  });

  it("DelegateAttempt with native binding", () => {
    const attempt: DelegateAttempt = {
      ...buildContractEnvelope("truth"),
      kind: "truth",
      attemptId: "att-1",
      delegateTaskId: "dt-1",
      attemptGeneration: 1,
      nativeBinding: {
        delegateTaskId: "dt-1",
        attemptId: "att-1",
        nativeFlowId: "flow-uuid",
        nativeTaskId: "task-uuid",
        claimOwner: "octoclaw-runtime",
        resumeGeneration: 1,
      },
      status: "running",
      claimOwner: "octoclaw-runtime",
      modelProfile: "worker_research",
      backend: "openclaw-native",
      workspaceMode: "isolated_worktree",
      startedAt: new Date().toISOString(),
    };
    expect(attempt.attemptGeneration).toBe(1);
    expect(attempt.nativeBinding?.nativeFlowId).toBe("flow-uuid");
  });

  it("RecoveryInfo classifies failure", () => {
    const recovery: RecoveryInfo = {
      category: "timeout",
      reason: "progress_timeout exceeded 30s",
      retryEligible: true,
      maxRetries: 3,
      timeoutCategory: "progress_timeout",
    };
    expect(recovery.retryEligible).toBe(true);
    expect(recovery.category).toBe("timeout");
  });

  it("TimeoutCategory covers all deadline types", () => {
    const categories: TimeoutCategory[] = [
      "queue_timeout", "start_timeout", "progress_timeout",
      "runtime_timeout", "delivery_timeout", "stale_timeout",
    ];
    expect(categories).toHaveLength(6);
  });

  it("RecoveryCategory covers all failure modes", () => {
    const categories: RecoveryCategory[] = [
      "transient_error", "timeout", "stale_claim", "worker_crash",
      "backend_unavailable", "scope_conflict", "input_required",
    ];
    expect(categories).toHaveLength(7);
  });

  it("DelegateProgressEvent carries structured progress", () => {
    const event: DelegateProgressEvent = {
      ...buildContractEnvelope("artifact"),
      kind: "artifact",
      eventId: "evt-1",
      delegateTaskId: "dt-1",
      attemptId: "att-1",
      eventType: "checkpoint",
      eventAt: new Date().toISOString(),
      summary: "checkpoint: research complete",
    };
    expect(event.eventType).toBe("checkpoint");
  });

  it("ResumePacket carries compact resume state", () => {
    const packet: ResumePacket = {
      ...buildContractEnvelope("artifact"),
      kind: "artifact",
      delegateTaskId: "dt-1",
      attemptId: "att-1",
      nativeBinding: {
        delegateTaskId: "dt-1",
        attemptId: "att-1",
        nativeFlowId: "flow-uuid",
        nativeTaskId: "task-uuid",
        claimOwner: "octoclaw-runtime",
        resumeGeneration: 1,
      },
      goal: "research openclaw versions",
      accumulatedArtifactRefs: ["artifact-1"],
      stateSnapshot: { lastStep: "search" },
      pendingSlots: [],
    };
    expect(packet.accumulatedArtifactRefs).toHaveLength(1);
  });

  it("StatusQueryPacket provides main-agent query surface", () => {
    const query: StatusQueryPacket = {
      ...buildContractEnvelope("projection"),
      kind: "projection",
      delegateTaskId: "dt-1",
      currentAttemptId: "att-1",
      currentAttemptStatus: "running",
      nativeBinding: {
        delegateTaskId: "dt-1",
        attemptId: "att-1",
        nativeFlowId: "flow-uuid",
        nativeTaskId: "task-uuid",
        claimOwner: "octoclaw-runtime",
        resumeGeneration: 1,
      },
      taskStatus: "active",
      role: "worker_research",
      coordinationMode: "solo_worker",
      modelProfile: "worker_research",
      backend: "openclaw-native",
      totalAttempts: 1,
      timeline: {
        entries: [
          { eventAt: new Date().toISOString(), eventType: "created", summary: "task created" },
        ],
        lastEventAt: new Date().toISOString(),
        totalEvents: 1,
      },
      recoveryInfo: null,
      queriedAt: new Date().toISOString(),
    };
    expect(query.taskStatus).toBe("active");
    expect(query.timeline.entries).toHaveLength(1);
  });

  it("FailureInfo provides structured failure detail", () => {
    const failure: FailureInfo = {
      reason: "progress_timeout exceeded",
      recoveryInfo: {
        category: "timeout",
        reason: "progress_timeout exceeded 30s",
        retryEligible: true,
        maxRetries: 3,
        timeoutCategory: "progress_timeout",
      },
      failedAt: new Date().toISOString(),
      attemptGeneration: 1,
    };
    expect(failure.recoveryInfo?.retryEligible).toBe(true);
  });
});
