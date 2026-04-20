import { describe, expect, it } from "vitest";
import type {
  DelegateAttempt,
  DelegateProgressEvent,
  DelegateTask,
  NativeTaskBinding,
} from "@octoclaw/contracts/delegate";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import {
  buildDetailsProjection,
  buildQueueProjection,
  buildStatusProjection,
} from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "planned",
    substrateRevision: 9,
    ownership: {
      claimOwner: "worker-beta",
      claimToken: "claim-token",
      controllerId: "controller-1",
    },
    scope: {
      readScope: [{ resource: "repo:src", access: "read" }],
      writeScope: [{ resource: "repo:src", access: "write" }],
      workspaceMode: "isolated_worktree",
      writeScopeSummary: "repo:src",
    },
    truth: {
      schemaVersion: "octoclaw.truth/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "truth",
      sessionKey: "session-1",
      requestId: "req-789",
      flowId: "flow-456",
      taskId: "task-123",
      runtime: "openclaw-native",
      syncMode: "managed",
      substrateState: "planned",
      substrateRevision: 9,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-beta",
        claimToken: "claim-token",
        controllerId: "controller-1",
      },
      scope: {
        workspaceMode: "isolated_worktree",
        readScopeCount: 1,
        writeScopeCount: 1,
        writeScopeSummary: "repo:src",
      },
    },
    projection: {
      schemaVersion: "octoclaw.projection/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "projection",
      status: "ignored-projection-status",
      runtime: "openclaw-native",
      flowId: "flow-456",
      taskId: "task-123",
      substrateState: "planned",
      substrateRevision: 9,
      workspaceMode: "isolated_worktree",
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "artifact",
      taskPacketRef: "packet-ref",
      schemaPlanes: ["truth", "projection", "artifact"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "telemetry",
      substrateRevision: 9,
      syncMode: "managed",
      claimOwner: "worker-beta",
    },
  };
}

function createDelegateTask(): DelegateTask {
  return {
    schemaVersion: "octoclaw.contracts/v1",
    createdAt: "2026-04-18T00:00:00.000Z",
    kind: "projection",
    delegateTaskId: "delegate-task-1",
    sessionId: "session-1",
    route: "delegate",
    role: "worker_executor",
    coordinationMode: "advisor_assisted",
    goal: "Inspect runtime status",
    status: "active",
    currentAttemptId: "attempt-1",
    totalAttempts: 3,
    updatedAt: "2026-04-18T00:02:00.000Z",
    lastEventAt: "2026-04-18T00:03:00.000Z",
    workspaceMode: "isolated_worktree",
    readScope: [{ resource: "repo:src", access: "read" }],
    writeScope: [{ resource: "repo:src", access: "write" }],
    writeScopeSummary: "repo:src",
  };
}

function createNativeBinding(): NativeTaskBinding {
  return {
    delegateTaskId: "delegate-task-1",
    attemptId: "attempt-1",
    nativeFlowId: "native-flow-1",
    nativeTaskId: "native-task-1",
    claimOwner: "worker-beta",
    resumeGeneration: 2,
    boundAt: "2026-04-18T00:01:00.000Z",
  };
}

function createDelegateAttempt(nativeBinding: NativeTaskBinding): DelegateAttempt {
  return {
    schemaVersion: "octoclaw.contracts/v1",
    createdAt: "2026-04-18T00:00:30.000Z",
    kind: "truth",
    attemptId: "attempt-1",
    delegateTaskId: "delegate-task-1",
    attemptGeneration: 2,
    nativeBinding,
    status: "running",
    claimOwner: "worker-beta",
    modelProfile: "worker_default",
    backend: "openclaw-native",
    workspaceMode: "isolated_worktree",
    startedAt: "2026-04-18T00:01:30.000Z",
  };
}

function createProgressEvents(): DelegateProgressEvent[] {
  return [
    {
      schemaVersion: "octoclaw.contracts/v1",
      createdAt: "2026-04-18T00:02:00.000Z",
      kind: "artifact",
      eventId: "evt-1",
      delegateTaskId: "delegate-task-1",
      attemptId: "attempt-1",
      eventType: "checkpoint",
      eventAt: "2026-04-18T00:02:00.000Z",
      summary: "Fetched repository state",
    },
    {
      schemaVersion: "octoclaw.contracts/v1",
      createdAt: "2026-04-18T00:03:00.000Z",
      kind: "artifact",
      eventId: "evt-2",
      delegateTaskId: "delegate-task-1",
      attemptId: "attempt-1",
      eventType: "deliverable_ready",
      eventAt: "2026-04-18T00:03:00.000Z",
      summary: "Prepared operator summary",
    },
  ];
}

describe("read-model", () => {
  it("buildStatusProjection reads from RuntimeStateSurfaceRecord", () => {
    const status = buildStatusProjection({ record: createRecord() });

    expect(status.taskId).toBe("task-123");
    expect(status.flowId).toBe("flow-456");
    expect(status.state).toBe("planned");
    expect(status.route).toBe("delegate");
    expect(status.workerPool).toBe("octoclaw-worker");
    expect(status.substrateSummary).toBe("openclaw-native managed planned");
    expect(status.claimOwner).toBe("worker-beta");
    expect(status.queuePosition).toBe(0);
    expect(status.modelSummary).toBe("unreported");
    expect(status.costEstimate).toBe("unreported");
    expect(status.leaseState).toBe("active");
    expect(status.workspaceMode).toBe("isolated_worktree");
    expect(status.writeScopeSummary).toBe("repo:src");
    expect(status.threadCount).toBe(1);
    expect(status.advisorUsageSummary).toBe("none");
  });

  it("buildStatusProjection reads delegate task, attempt, binding, and progress events", () => {
    const nativeBinding = createNativeBinding();
    const delegateTask = createDelegateTask();
    const delegateAttempt = createDelegateAttempt(nativeBinding);
    const progressEvents = createProgressEvents();

    const status = buildStatusProjection({
      record: createRecord(),
      delegateTask,
      delegateAttempt,
      nativeBinding,
      progressEvents,
    });

    expect(status.taskId).toBe("native-task-1");
    expect(status.flowId).toBe("native-flow-1");
    expect(status.state).toBe("running");
    expect(status.route).toBe("delegate");
    expect(status.role).toBe("worker_executor");
    expect(status.coordinationMode).toBe("advisor_assisted");
    expect(status.substrateSummary).toBe("openclaw-native managed running");
    expect(status.timelinePreview).toEqual([
      {
        eventType: "checkpoint",
        eventAt: "2026-04-18T00:02:00.000Z",
        summary: "Fetched repository state",
      },
      {
        eventType: "deliverable_ready",
        eventAt: "2026-04-18T00:03:00.000Z",
        summary: "Prepared operator summary",
      },
    ]);
  });

  it("buildStatusProjection remains backward compatible without delegate task", () => {
    const status = buildStatusProjection({ record: createRecord() });

    expect(status.route).toBe("delegate");
    expect(status.role).toBe("worker_research");
    expect(status.coordinationMode).toBe("solo_worker");
    expect(status.timelinePreview).toEqual([]);
  });

  it("buildQueueProjection includes isStale and conflictQueued flags", () => {
    const queue = buildQueueProjection({
      record: createRecord(),
      queuePosition: 2,
      leaseState: "active",
      isStale: true,
      conflictQueued: true,
    });

    expect(queue.queuePosition).toBe(2);
    expect(queue.leaseState).toBe("active");
    expect(queue.isStale).toBe(true);
    expect(queue.conflictQueued).toBe(true);
  });

  it("buildQueueProjection uses delegate task and attempt state", () => {
    const delegateTask = {
      ...createDelegateTask(),
      status: "recovering",
    } satisfies DelegateTask;
    const queue = buildQueueProjection({
      record: createRecord(),
      delegateTask,
      delegateAttempt: createDelegateAttempt(createNativeBinding()),
    });

    expect(queue.taskStatus).toBe("recovering");
    expect(queue.attemptStatus).toBe("running");
    expect(queue.delegateTaskId).toBe("delegate-task-1");
    expect(queue.attemptId).toBe("attempt-1");
    expect(queue.substrateSummary).toBe("openclaw-native managed running");
    expect(queue.isStale).toBe(true);
  });

  it("buildDetailsProjection includes all substrate fields", () => {
    const record = createRecord();
    const details = buildDetailsProjection({
      record,
      queuePosition: 4,
      modelSummary: "gpt-5.4 / balanced",
      costEstimate: "$0.01",
      leaseState: "expiring",
      isStale: true,
      conflictQueued: false,
      actionAvailability: ["status", "details", "queue", "timeline"],
    });

    expect(details.taskId).toBe(record.truth.taskId);
    expect(details.flowId).toBe(record.truth.flowId);
    expect(details.substrateState).toBe(record.substrateState);
    expect(details.substrateRevision).toBe(record.substrateRevision);
    expect(details.syncMode).toBe(record.syncMode);
    expect(details.runtime).toBe(record.runtime);
    expect(details.claimOwner).toBe(record.ownership.claimOwner);
    expect(details.workspaceMode).toBe(record.scope.workspaceMode);
    expect(details.writeScopeSummary).toBe(record.scope.writeScopeSummary);
    expect(details.truth).toBe(record.truth);
    expect(details.projection).toBe(record.projection);
    expect(details.summary).toBe("openclaw-native managed planned");
    expect(details.leaseState).toBe("expiring");
    expect(details.modelSummary).toBe("gpt-5.4 / balanced");
    expect(details.costEstimate).toBe("$0.01");
    expect(details.queuePosition).toBe(4);
    expect(details.isStale).toBe(true);
    expect(details.conflictQueued).toBe(false);
    expect(details.actionAvailability).toEqual(["status", "details", "queue", "timeline"]);
  });

  it("buildDetailsProjection includes delegate attempt metadata", () => {
    const nativeBinding = createNativeBinding();
    const details = buildDetailsProjection({
      record: createRecord(),
      delegateTask: createDelegateTask(),
      delegateAttempt: createDelegateAttempt(nativeBinding),
      nativeBinding,
    });

    expect(details.taskId).toBe("native-task-1");
    expect(details.flowId).toBe("native-flow-1");
    expect(details.delegateTaskId).toBe("delegate-task-1");
    expect(details.attemptId).toBe("attempt-1");
    expect(details.attemptGeneration).toBe(2);
    expect(details.attemptStatus).toBe("running");
    expect(details.totalAttempts).toBe(3);
    expect(details.taskStatus).toBe("active");
    expect(details.summary).toBe("openclaw-native managed running");
  });

  it('substrateSummary format is "<runtime> <syncMode> <substrateState>"', () => {
    const status = buildStatusProjection({ record: createRecord() });
    const queue = buildQueueProjection({ record: createRecord() });
    const details = buildDetailsProjection({ record: createRecord() });

    expect(status.substrateSummary).toBe("openclaw-native managed planned");
    expect(queue.substrateSummary).toBe("openclaw-native managed planned");
    expect(details.summary).toBe("openclaw-native managed planned");
  });
});
