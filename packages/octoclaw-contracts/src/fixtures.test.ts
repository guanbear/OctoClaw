import { describe, expect, it } from "vitest";
import type { DeliveryEnvelope } from "./deliveries.js";
import {
  DELIVERY_ENVELOPE_FIXTURE,
  STATUS_SURFACE_FIXTURE,
  WORKER_RESULT_FIXTURE,
} from "./fixtures.js";
import type { StatusSurfaceViewModel, WorkerResult } from "./results.js";

describe("fixtures", () => {
  it("provides a valid worker result fixture", () => {
    const fixture: WorkerResult = WORKER_RESULT_FIXTURE;

    expect(fixture.status).toBe("success");
    expect(fixture.acceptanceResults.length).toBeGreaterThan(0);
    expect(fixture.artifactRefs.length).toBeGreaterThan(0);
  });

  it("provides a valid delivery envelope fixture", () => {
    const fixture: DeliveryEnvelope = DELIVERY_ENVELOPE_FIXTURE;

    expect(fixture.status).toBe("queued");
    expect(fixture.channel).toBe("slack");
    expect(fixture.requestIdempotencyKey).toBeTruthy();
  });

  it("provides a status surface fixture with all required minimum fields", () => {
    const fixture: StatusSurfaceViewModel = STATUS_SURFACE_FIXTURE;

    expect(fixture.taskId).toBeTruthy();
    expect(fixture.flowId).toBeTruthy();
    expect(fixture.state).toBeTruthy();
    expect(fixture.route).toBeTruthy();
    expect(fixture.workerPool).toBeTruthy();
    expect(fixture.substrateSummary).toBeTruthy();
    expect(fixture.actionAvailability.length).toBeGreaterThan(0);
    expect(fixture.queuePosition).toBeTypeOf("number");
    expect(fixture.modelSummary).toBeTruthy();
    expect(fixture.costEstimate).toBeTruthy();
    expect(fixture.claimOwner).toBeTruthy();
    expect(fixture.leaseState).toBeTruthy();
    expect(fixture.workspaceMode).toBeTruthy();
    expect(fixture.writeScopeSummary).toBeTruthy();
    expect(fixture.threadCount).toBeTypeOf("number");
    expect(fixture.advisorUsageSummary).toBeTruthy();
  });
});
