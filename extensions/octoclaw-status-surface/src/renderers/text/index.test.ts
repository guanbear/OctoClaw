import { describe, expect, it } from "vitest";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { buildDetailsProjection, buildQueueProjection } from "../../read-model/index.js";
import { buildStatusSurface, buildTimelinePlaceholder } from "../../view-model/index.js";
import {
  renderDetailsText,
  renderQueueText,
  renderStatusText,
  renderTimelineText,
} from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "running",
    substrateRevision: 3,
    ownership: {
      claimOwner: "worker-text",
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
      substrateState: "running",
      substrateRevision: 3,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-text",
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
      status: "projection-only-state",
      runtime: "openclaw-native",
      flowId: "flow-456",
      taskId: "task-123",
      substrateState: "running",
      substrateRevision: 3,
      workspaceMode: "isolated_workspace",
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
      substrateRevision: 3,
      syncMode: "managed",
      claimOwner: "worker-text",
    },
  };
}

describe("text renderer", () => {
  it("produces non-empty plain text for status, details, queue, and timeline", () => {
    const record = createRecord();
    const statusText = renderStatusText(buildStatusSurface(record));
    const detailsText = renderDetailsText(buildDetailsProjection({ record, isStale: true, conflictQueued: false }));
    const queueText = renderQueueText(buildQueueProjection({ record, queuePosition: 1 }));
    const timelineText = renderTimelineText(buildTimelinePlaceholder(record));

    expect(statusText.trim().length).toBeGreaterThan(0);
    expect(detailsText.trim().length).toBeGreaterThan(0);
    expect(queueText.trim().length).toBeGreaterThan(0);
    expect(timelineText.trim().length).toBeGreaterThan(0);
  });

  it("reads from substrate-first data on the view model", () => {
    const text = renderStatusText(buildStatusSurface(createRecord()));

    expect(text).toContain("state=running");
    expect(text).toContain("substrate=openclaw-native managed running");
    expect(text).toContain("claim_owner=worker-text");
  });

  it("does not fabricate state from projection-only values", () => {
    const record = createRecord();
    const statusText = renderStatusText(buildStatusSurface(record));
    const detailsText = renderDetailsText(buildDetailsProjection({ record }));

    expect(statusText).not.toContain("projection-only-state");
    expect(detailsText).not.toContain("projection-only-state");
    expect(statusText).toContain("state=running");
    expect(detailsText).toContain("state=running");
  });
});
