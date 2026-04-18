import { describe, expect, it } from "vitest";
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
      workspaceMode: "isolated_workspace",
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
        workspaceMode: "isolated_workspace",
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
      workspaceMode: "isolated_workspace",
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

describe("read-model", () => {
  it("buildStatusProjection reads from RuntimeStateSurfaceRecord", () => {
    const status = buildStatusProjection({ record: createRecord() });

    expect(status.taskId).toBe("task-123");
    expect(status.flowId).toBe("flow-456");
    expect(status.state).toBe("planned");
    expect(status.route).toBe("delegate.single");
    expect(status.workerPool).toBe("octoclaw-worker");
    expect(status.substrateSummary).toBe("openclaw-native managed planned");
    expect(status.claimOwner).toBe("worker-beta");
    expect(status.workspaceMode).toBe("isolated_workspace");
    expect(status.writeScopeSummary).toBe("repo:src");
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

  it('substrateSummary format is "<runtime> <syncMode> <substrateState>"', () => {
    const status = buildStatusProjection({ record: createRecord() });
    const queue = buildQueueProjection({ record: createRecord() });
    const details = buildDetailsProjection({ record: createRecord() });

    expect(status.substrateSummary).toBe("openclaw-native managed planned");
    expect(queue.substrateSummary).toBe("openclaw-native managed planned");
    expect(details.summary).toBe("openclaw-native managed planned");
  });
});
