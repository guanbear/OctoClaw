import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegateAttempt, DelegateProgressEvent, RecoveryInfo } from "@octoclaw/contracts/delegate";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import {
  buildStatusQueryPacket,
  createDelegateTask,
  recordProgressEvent,
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

function buildPendingTask() {
  return createDelegateTask({
    sessionId: "session-query",
    role: "worker_research",
    coordinationMode: "solo_worker",
    goal: "Inspect delegate state",
    scope: buildScope(),
  });
}

function buildActiveAttempt() {
  const task = buildPendingTask();
  const started = startDelegateAttempt(task, {
    nativeFlowId: "native-flow-query",
    nativeTaskId: "native-task-query",
    claimOwner: "octoclaw-runtime",
    modelProfile: "worker_research",
    backend: "openclaw-native",
    workspaceMode: "isolated_worktree",
  });
  return started;
}

describe("buildStatusQueryPacket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a query packet with active attempt and events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    const started = buildActiveAttempt();

    vi.setSystemTime(new Date("2026-04-21T10:00:02.000Z"));
    const checkpoint = recordProgressEvent(started.task.delegateTaskId, started.attempt.attemptId, "checkpoint", "Checkpoint emitted");
    vi.setSystemTime(new Date("2026-04-21T10:00:03.000Z"));
    const deliverable = recordProgressEvent(started.task.delegateTaskId, started.attempt.attemptId, "deliverable_ready", "Draft ready");
    vi.setSystemTime(new Date("2026-04-21T10:00:04.000Z"));

    const packet = buildStatusQueryPacket({
      delegateTask: started.task,
      currentAttempt: started.attempt,
      nativeBinding: started.binding,
      progressEvents: [checkpoint, deliverable],
    });

    expect(packet).toMatchObject({
      kind: "projection",
      delegateTaskId: started.task.delegateTaskId,
      currentAttemptId: started.task.currentAttemptId,
      currentAttemptStatus: "queued",
      nativeBinding: started.binding,
      taskStatus: "active",
      role: "worker_research",
      coordinationMode: "solo_worker",
      modelProfile: "worker_research",
      backend: "openclaw-native",
      totalAttempts: 1,
      recoveryInfo: null,
      queriedAt: "2026-04-21T10:00:04.000Z",
      timeline: {
        lastEventAt: "2026-04-21T10:00:03.000Z",
        totalEvents: 2,
      },
    });
    expect(packet.timeline.entries).toEqual([
      {
        eventAt: "2026-04-21T10:00:02.000Z",
        eventType: "checkpoint",
        summary: "Checkpoint emitted",
      },
      {
        eventAt: "2026-04-21T10:00:03.000Z",
        eventType: "deliverable_ready",
        summary: "Draft ready",
      },
    ]);
  });

  it("builds a query packet with no attempt for a pending task", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));
    const task = buildPendingTask();

    const packet = buildStatusQueryPacket({
      delegateTask: task,
      currentAttempt: null,
      nativeBinding: null,
      progressEvents: [],
    });

    expect(packet).toMatchObject({
      delegateTaskId: task.delegateTaskId,
      currentAttemptId: null,
      currentAttemptStatus: null,
      nativeBinding: null,
      taskStatus: "pending",
      modelProfile: null,
      backend: null,
      totalAttempts: 0,
      recoveryInfo: null,
      queriedAt: "2026-04-21T11:00:00.000Z",
      timeline: {
        entries: [],
        lastEventAt: null,
        totalEvents: 0,
      },
    });
  });

  it("builds a query packet with recovery info", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    const started = buildActiveAttempt();
    const recoveryInfo: RecoveryInfo = {
      category: "timeout",
      reason: "progress timeout exceeded",
      retryEligible: true,
      maxRetries: 2,
      timeoutCategory: "progress_timeout",
    };

    const packet = buildStatusQueryPacket({
      delegateTask: started.task,
      currentAttempt: started.attempt,
      nativeBinding: started.binding,
      progressEvents: [],
      recoveryInfo,
    });

    expect(packet.recoveryInfo).toEqual(recoveryInfo);
  });

  it("builds a sorted timeline capped to the last 50 events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T13:00:00.000Z"));
    const started = buildActiveAttempt();
    const events: DelegateProgressEvent[] = [];

    for (let index = 0; index < 55; index += 1) {
      vi.setSystemTime(new Date(`2026-04-21T13:00:${String(index).padStart(2, "0")}.000Z`));
      events.unshift(recordProgressEvent(started.task.delegateTaskId, started.attempt.attemptId, "checkpoint", `event-${index}`));
    }

    vi.setSystemTime(new Date("2026-04-21T13:01:00.000Z"));
    const packet = buildStatusQueryPacket({
      delegateTask: started.task,
      currentAttempt: started.attempt as DelegateAttempt,
      nativeBinding: started.binding,
      progressEvents: events,
    });

    expect(packet.timeline.totalEvents).toBe(55);
    expect(packet.timeline.entries).toHaveLength(50);
    expect(packet.timeline.entries[0]).toMatchObject({
      eventAt: "2026-04-21T13:00:05.000Z",
      summary: "event-5",
    });
    expect(packet.timeline.entries.at(-1)).toMatchObject({
      eventAt: "2026-04-21T13:00:54.000Z",
      summary: "event-54",
    });
    expect(packet.timeline.lastEventAt).toBe("2026-04-21T13:00:54.000Z");
  });
});
