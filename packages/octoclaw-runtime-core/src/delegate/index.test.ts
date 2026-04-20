import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import {
  advanceAttemptStatus,
  buildResumePacket,
  createDelegateTask,
  projectTaskStatus,
  recordProgressEvent,
  retryDelegateAttempt,
  startDelegateAttempt,
} from "./index.js";

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "isolated_worktree",
    readScope: [{ resource: "repo", access: "read" }],
    writeScope: [{ resource: "repo", access: "write" }],
    writeScopeSummary: "repo",
  };
}

describe("delegate lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("createDelegateTask produces the initial pending state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const task = createDelegateTask({
      sessionId: "session-1",
      role: "worker_research",
      coordinationMode: "solo_worker",
      goal: "Investigate runtime binding",
      scope: buildScope(),
    });

    expect(task).toMatchObject({
      kind: "projection",
      route: "delegate",
      sessionId: "session-1",
      role: "worker_research",
      coordinationMode: "solo_worker",
      goal: "Investigate runtime binding",
      status: "pending",
      currentAttemptId: null,
      totalAttempts: 0,
      createdAt: "2026-04-21T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(task.delegateTaskId).toBe("delegate-task:session-1:1776765600000");
  });

  it("startDelegateAttempt increments totalAttempts, sets currentAttemptId, and produces binding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    const task = createDelegateTask({
      sessionId: "session-1",
      role: "worker_research",
      coordinationMode: "solo_worker",
      goal: "Investigate runtime binding",
      scope: buildScope(),
    });

    vi.setSystemTime(new Date("2026-04-21T10:00:05.000Z"));
    const started = startDelegateAttempt(task, {
      nativeFlowId: "native-flow-1",
      nativeTaskId: "native-task-1",
      claimOwner: "octoclaw-runtime",
      modelProfile: "worker_research",
      backend: "openclaw-native",
      workspaceMode: "isolated_worktree",
    });

    expect(started.task.totalAttempts).toBe(1);
    expect(started.task.currentAttemptId).toBe(started.attempt.attemptId);
    expect(started.task.status).toBe("active");
    expect(started.attempt).toMatchObject({
      delegateTaskId: task.delegateTaskId,
      attemptGeneration: 1,
      status: "queued",
      claimOwner: "octoclaw-runtime",
      modelProfile: "worker_research",
      backend: "openclaw-native",
      workspaceMode: "isolated_worktree",
      queuedAt: "2026-04-21T10:00:05.000Z",
    });
    expect(started.binding).toEqual({
      delegateTaskId: task.delegateTaskId,
      attemptId: started.attempt.attemptId,
      nativeFlowId: "native-flow-1",
      nativeTaskId: "native-task-1",
      claimOwner: "octoclaw-runtime",
      resumeGeneration: 1,
      boundAt: "2026-04-21T10:00:05.000Z",
    });
  });

  it("retryDelegateAttempt creates a new attempt on the same delegate task with incremented generation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    const task = createDelegateTask({
      sessionId: "session-1",
      role: "worker_code",
      coordinationMode: "advisor_assisted",
      goal: "Apply code fix",
      scope: buildScope(),
    });
    vi.setSystemTime(new Date("2026-04-21T10:00:05.000Z"));
    const first = startDelegateAttempt(task, {
      nativeFlowId: "native-flow-1",
      nativeTaskId: "native-task-1",
      claimOwner: "worker-a",
      modelProfile: "worker_code_normal",
      backend: "openclaw-native",
      workspaceMode: "isolated_worktree",
    });
    vi.setSystemTime(new Date("2026-04-21T10:00:08.000Z"));
    const failed = advanceAttemptStatus(first.attempt, "failed", { failureReason: "transient" });
    vi.setSystemTime(new Date("2026-04-21T10:00:10.000Z"));
    const retried = retryDelegateAttempt(first.task, failed, {
      nativeFlowId: "native-flow-2",
      nativeTaskId: "native-task-2",
      claimOwner: "worker-b",
      modelProfile: "worker_code_deep",
      backend: "clawteam",
      workspaceMode: "shared_workspace",
    });

    expect(retried.task.delegateTaskId).toBe(task.delegateTaskId);
    expect(retried.task.totalAttempts).toBe(2);
    expect(retried.attempt.delegateTaskId).toBe(task.delegateTaskId);
    expect(retried.attempt.attemptGeneration).toBe(2);
    expect(retried.binding.resumeGeneration).toBe(2);
    expect(retried.attempt.attemptId).not.toBe(first.attempt.attemptId);
  });

  it("projects delegate task status from attempt status", () => {
    expect(projectTaskStatus(null)).toBe("pending");
    expect(projectTaskStatus("pending")).toBe("pending");
    expect(projectTaskStatus("queued")).toBe("active");
    expect(projectTaskStatus("running")).toBe("active");
    expect(projectTaskStatus("checkpoint")).toBe("active");
    expect(projectTaskStatus("deliverable_ready")).toBe("active");
    expect(projectTaskStatus("waiting_input")).toBe("active");
    expect(projectTaskStatus("completed")).toBe("completed");
    expect(projectTaskStatus("failed")).toBe("failed");
    expect(projectTaskStatus("timed_out")).toBe("timed_out");
    expect(projectTaskStatus("recovering")).toBe("recovering");
    expect(projectTaskStatus("cancelled")).toBe("cancelled");
  });

  it("records progress events and resume packets from current attempt state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    const task = createDelegateTask({
      sessionId: "session-2",
      role: "worker_review",
      coordinationMode: "multi_agent_controlled",
      goal: "Review artifacts",
      scope: buildScope(),
    });
    vi.setSystemTime(new Date("2026-04-21T10:00:01.000Z"));
    const started = startDelegateAttempt(task, {
      nativeFlowId: "native-flow-9",
      nativeTaskId: "native-task-9",
      claimOwner: "worker-review",
      modelProfile: "worker_review",
      backend: "openclaw-native",
      workspaceMode: "isolated_worktree",
    });
    vi.setSystemTime(new Date("2026-04-21T10:00:02.000Z"));
    const running = advanceAttemptStatus(started.attempt, "running");
    const event = recordProgressEvent(started.task.delegateTaskId, running.attemptId, "checkpoint", "Checkpoint emitted");
    const packet = buildResumePacket(started.task, running, started.binding);

    expect(event).toMatchObject({
      delegateTaskId: started.task.delegateTaskId,
      attemptId: running.attemptId,
      eventType: "checkpoint",
      summary: "Checkpoint emitted",
      eventAt: "2026-04-21T10:00:02.000Z",
    });
    expect(packet).toMatchObject({
      delegateTaskId: started.task.delegateTaskId,
      attemptId: running.attemptId,
      nativeBinding: started.binding,
      goal: "Review artifacts",
      accumulatedArtifactRefs: [],
      pendingSlots: [],
      stateSnapshot: {
        taskStatus: "active",
        currentAttemptId: running.attemptId,
        totalAttempts: 1,
        attemptStatus: "running",
        attemptGeneration: 1,
        claimOwner: "worker-review",
        backend: "openclaw-native",
        modelProfile: "worker_review",
        workspaceMode: "isolated_worktree",
      },
    });
  });
});
