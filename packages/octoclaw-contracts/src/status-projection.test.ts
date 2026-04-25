import { describe, expect, it } from "vitest";
import type { WorkContract } from "./work-contract.js";
import { buildMultiTaskStatusProjection, buildTaskStatusProjection } from "./status-projection.js";

function contract(overrides: Partial<WorkContract> = {}): WorkContract {
  const base: WorkContract = {
    schemaVersion: "octoclaw.work_contract.v1",
    workContractId: "wc-1",
    turnId: "turn-1",
    sessionKey: "session-1",
    userAsk: "implement status truth",
    intentClass: "delegated_work",
    route: "delegate",
    status: "sealed",
    coverage: {
      precheckOrder: [
        "conversation_grounding",
        "continuation_route_reuse",
        "execution_coverage",
        "memory_coverage",
        "build_judge_context_packet",
        "local_judge",
        "validator_or_remote",
        "route_seal_commit",
      ],
      execution: { coverage: "thread" },
      memory: { coverage: "partial" },
      conflict: false,
      authority: "execution_wins",
    },
    decision: {
      source: "local_judge",
      route: "delegate",
      reasonCodes: ["delegated_work"],
      sealedAt: "2026-04-25T00:00:00.000Z",
    },
    delegate: {
      delegateTaskId: "delegate-1",
      currentAttemptId: "attempt-1",
      role: "code",
      coordinationMode: "solo_worker",
      acceptanceCriteria: ["pass tests"],
      scope: {
        read: ["src"],
        write: ["src"],
        workspaceMode: "write_allowed",
        scopeFingerprint: "scope-1",
      },
      modelProfile: "code-fast",
      nativeBinding: null,
      childSessions: [],
      artifactRefs: [],
      nextAction: "dispatch",
    },
    continuity: {
      threadBindingKey: "thread-1",
      parentSessionKey: "session-1",
      continuationMode: "status_only",
    },
    mainContext: {
      summary: "implement status truth",
      statusLine: "sealed",
      visibleIds: { workContractId: "wc-1" },
      artifactRefs: [],
      nextAction: "dispatch",
      tokenBudget: { maxResumeTokens: 700, maxArtifactSummaryTokens: 250 },
      forbiddenContent: ["full_transcript"],
    },
    telemetry: {},
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:30.000Z",
  };
  return { ...base, ...overrides };
}

it("does not project a registered TaskFlow as running without execution evidence", () => {
  const projection = buildTaskStatusProjection({
    contract: contract({
      delegate: {
        ...contract().delegate!,
        nativeBinding: {
          flowId: "flow-1",
          ownerKey: "wc-1",
          controllerId: "octoclaw.delegate",
          revision: 1,
          expectedRevision: 1,
          syncMode: "managed",
          status: "queued",
        },
      },
    }),
    now: "2026-04-25T00:01:00.000Z",
  });

  expect(projection.status).toBe("materializing");
  expect(projection.spawnExecuted).toBe(false);
});

describe("TaskStatusProjection", () => {
  it("distinguishes dispatchExecuted from spawnExecuted", () => {
    const projection = buildTaskStatusProjection({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: false } }),
      now: "2026-04-25T00:02:00.000Z",
    });

    expect(projection.status).toBe("queued");
    expect(projection.success).toBe(false);
  });

  it("projects child continuity, artifacts, model, backend, cost, and elapsed time", () => {
    const projection = buildTaskStatusProjection({
      contract: contract({
        status: "running",
        delegate: {
          ...contract().delegate!,
          nativeBinding: {
            flowId: "flow-1",
            ownerKey: "wc-1",
            controllerId: "octoclaw.delegate",
            revision: 3,
            expectedRevision: 3,
            runId: "run-1",
            childRunId: "child-run-1",
            childSessionKey: "child-key-1",
            syncMode: "managed",
            status: "running",
          },
          artifactRefs: [{ artifactId: "artifact-1", artifactKind: "worker_report", createdAt: "2026-04-25T00:01:00.000Z" }],
        },
        telemetry: {
          dispatchExecuted: true,
          spawnExecuted: true,
          estimatedCostUsd: 0.02,
          actualCostUsd: 0.03,
        },
      }),
      heartbeatAt: "2026-04-25T00:01:50.000Z",
      now: "2026-04-25T00:02:00.000Z",
    });

    expect(projection).toMatchObject({
      taskSummary: "implement status truth",
      elapsedMs: 120_000,
      modelProfile: "code-fast",
      backend: "octoclaw.delegate",
      status: "running",
      estimatedCostUsd: 0.02,
      actualCostUsd: 0.03,
      childSessionKey: "child-key-1",
      runId: "run-1",
      childRunId: "child-run-1",
    });
    expect(projection.artifactRefs).toEqual([{ artifactId: "artifact-1", artifactKind: "worker_report" }]);
  });

  it("projects stale heartbeat as timed_out and final materialization as deliverable_ready/completed", () => {
    expect(buildTaskStatusProjection({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true } }),
      heartbeatAt: "2026-04-25T00:00:00.000Z",
      now: "2026-04-25T00:10:01.000Z",
    }).status).toBe("timed_out");

    const ready = contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true, deliveryStatus: "pending" } });
    expect(buildTaskStatusProjection({ contract: ready }).status).toBe("deliverable_ready");
    expect(buildTaskStatusProjection({ contract: ready, deliveryAcknowledged: true }).status).toBe("completed");
  });
});

describe("MultiTaskStatusProjection", () => {
  it("counts projected statuses", () => {
    const projection = buildMultiTaskStatusProjection([
      { contract: contract({ workContractId: "wc-1" }) },
      { contract: contract({ workContractId: "wc-2", telemetry: { dispatchExecuted: true } }) },
    ], "2026-04-25T00:03:00.000Z");

    expect(projection.generatedAt).toBe("2026-04-25T00:03:00.000Z");
    expect(projection.counts.registered).toBe(1);
    expect(projection.counts.queued).toBe(1);
  });
});
