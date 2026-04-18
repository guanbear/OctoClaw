import { describe, expect, it } from "vitest";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { buildDetailsProjection, buildQueueProjection } from "../../read-model/index.js";
import { buildStatusSurface, buildTimelinePlaceholder } from "../../view-model/index.js";
import { renderStatusText } from "../text/index.js";
import {
  renderDetailsRich,
  renderQueueRich,
  renderStatusRich,
  renderTimelineRich,
} from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "running",
    substrateRevision: 5,
    ownership: {
      claimOwner: "worker-rich",
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
      substrateState: "running",
      substrateRevision: 5,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-rich",
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
      status: "projection-status",
      runtime: "openclaw-native",
      flowId: "flow-456",
      taskId: "task-123",
      substrateState: "running",
      substrateRevision: 5,
      workspaceMode: "isolated_worktree",
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "artifact",
      taskPacketRef: "packet-ref",
      schemaPlanes: ["truth", "projection"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "telemetry",
      substrateRevision: 5,
      syncMode: "managed",
      claimOwner: "worker-rich",
    },
  };
}

describe("rich renderer", () => {
  it("produces structured output for status, details, queue, and timeline", () => {
    const record = createRecord();
    const status = renderStatusRich(buildStatusSurface(record));
    const details = renderDetailsRich(buildDetailsProjection({ record }));
    const queue = renderQueueRich(buildQueueProjection({ record, queuePosition: 6, conflictQueued: true }));
    const timeline = renderTimelineRich(buildTimelinePlaceholder(record));

    expect(status).toMatchObject({
      kind: "status_card",
      title: "task-123",
      state: "running",
      route: "delegate.single",
      workerPool: "octoclaw-worker",
      substrateSummary: "openclaw-native managed running",
    });
    expect(details).toMatchObject({
      kind: "details_card",
      title: "task-123",
      flowId: "flow-456",
      state: "running",
      revision: 5,
      runtime: "openclaw-native",
      summary: "openclaw-native managed running",
    });
    expect(queue).toMatchObject({
      kind: "queue_card",
      taskId: "task-123",
      flowId: "flow-456",
      queuePosition: 6,
      substrateSummary: "openclaw-native managed running",
      conflictQueued: true,
    });
    expect(timeline).toMatchObject({
      kind: "timeline_card",
      taskId: "task-123",
      flowId: "flow-456",
      summary: "timeline placeholder for task-123",
      available: true,
      events: [],
    });
  });

  it("both renderers consume the same view model", () => {
    const view = buildStatusSurface(createRecord());
    const text = renderStatusText(view);
    const rich = renderStatusRich(view);

    expect(text).toContain(`Status: ${view.taskId}`);
    expect(text).toContain(`state=${view.state}`);
    expect(rich.title).toBe(view.taskId);
    expect(rich.state).toBe(view.state);
    expect(rich.route).toBe(view.route);
    expect(rich.substrateSummary).toBe(view.substrateSummary);
  });
});
