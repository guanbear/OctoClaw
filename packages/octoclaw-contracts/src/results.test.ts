import { describe, expect, it } from "vitest";
import { buildContractEnvelope } from "./schemas.js";
import type { DelegatedMaterialization, StatusSurfaceViewModel, WorkerResult } from "./results.js";

describe("results", () => {
  it("requires worker result acceptance results", () => {
    const result: WorkerResult = {
      ...buildContractEnvelope("artifact", "2026-04-18T00:00:00.000Z"),
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
      lastHeartbeatAt: "2026-04-18T00:00:00.000Z",
      readScope: [{ resource: "docs", access: "read" }],
      writeScope: [{ resource: "workspace", access: "write" }],
      workspaceMode: "shared_workspace",
      taskId: "task-1",
      flowId: "flow-1",
      resultId: "result-1",
      status: "success",
      summary: "done",
      artifactRefs: ["artifact://report"],
      acceptanceResults: [{
        criterion: { id: "criterion-1", description: "return result", required: true },
        satisfied: true,
        evidence: "report",
      }],
    };

    expect(Array.isArray(result.acceptanceResults)).toBe(true);
    expect(result.acceptanceResults).toHaveLength(1);
  });

  it("supports status surface with all 13 minimum ws6 fields", () => {
    const viewModel: StatusSurfaceViewModel = {
      ...buildContractEnvelope("projection", "2026-04-18T00:00:00.000Z"),
      taskId: "task-1",
      flowId: "flow-1",
      state: "running",
      route: "delegate.single",
      workerPool: "octoclaw-worker",
      substrateSummary: "running",
      actionAvailability: ["status", "details"],
      queuePosition: 1,
      modelSummary: "worker_default",
      costEstimate: "$0.01",
      claimOwner: "octoclaw-runtime",
      leaseState: "active",
      workspaceMode: "shared_workspace",
      writeScopeSummary: "workspace",
    };

    expect(viewModel.taskId).toBeTruthy();
    expect(viewModel.flowId).toBeTruthy();
    expect(viewModel.state).toBeTruthy();
    expect(viewModel.route).toBeTruthy();
    expect(viewModel.workerPool).toBeTruthy();
    expect(viewModel.substrateSummary).toBeTruthy();
    expect(viewModel.actionAvailability.length).toBeGreaterThan(0);
    expect(viewModel.queuePosition).toBeTypeOf("number");
    expect(viewModel.modelSummary).toBeTruthy();
    expect(viewModel.costEstimate).toBeTruthy();
    expect(viewModel.claimOwner).toBeTruthy();
    expect(viewModel.leaseState).toBeTruthy();
    expect(viewModel.workspaceMode).toBeTruthy();
  });

  it("includes delegated materialization sync mode and substrate revision", () => {
    const materialization: DelegatedMaterialization = {
      ...buildContractEnvelope("artifact", "2026-04-18T00:00:00.000Z"),
      requestId: "request-1",
      taskId: "task-1",
      flowId: "flow-1",
      route: "delegate.single",
      authority: "runtime_orchestrator",
      backend: "openclaw-native",
      materializationIntent: "spawn_single",
      source: "runtime_orchestrator",
      sourceRef: "judge-1",
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
      lastHeartbeatAt: "2026-04-18T00:00:00.000Z",
      readScope: [{ resource: "docs", access: "read" }],
      writeScope: [{ resource: "workspace", access: "write" }],
      workspaceMode: "shared_workspace",
      materializationId: "materialization-1",
      substrateState: "running",
      substrateRevision: 2,
      syncMode: "managed",
      delegatedAt: "2026-04-18T00:00:02.000Z",
    };

    expect(materialization.syncMode).toBe("managed");
    expect(materialization.substrateRevision).toBe(2);
  });
});
