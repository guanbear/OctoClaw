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
      schemaVersion: "octoclaw.task_status_projection/v1",
      requestId: "turn-1",
      flowId: "flow-1",
      taskId: "delegate-1",
      parentThreadKey: "thread-1",
      title: "implement status truth",
      summary: "sealed",
      taskSummary: "implement status truth",
      route: "delegate",
      role: "code",
      coordinationMode: "solo_worker",
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
    expect(projection.artifactRefIds).toEqual(["artifact-1"]);
    expect(projection.nativeFlowRevision).toBe(3);
    expect(projection.nativeFlowExpectedRevision).toBe(3);
    expect(projection.actions).toContain("open");
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

    expect(projection.schemaVersion).toBe("octoclaw.multi_task_status_projection/v1");
    expect(projection.generatedAt).toBe("2026-04-25T00:03:00.000Z");
    expect(projection.scope).toBe("thread");
    expect(projection.activeCount).toBe(1);
    expect(projection.threadKey).toBe("thread-1");
    expect(projection.counts.registered).toBe(1);
    expect(projection.counts.queued).toBe(1);
  });
});

describe("Phase B acceptance: status no-lie rules", () => {
  const now = "2026-04-25T00:10:00.000Z";
  const staleAfterMs = 5 * 60 * 1000;
  const nativeBinding = {
    flowId: "flow-1",
    ownerKey: "wc-1",
    controllerId: "octoclaw.delegate",
    revision: 1,
    expectedRevision: 1,
    syncMode: "managed",
    status: "queued",
  } as const;

  function projectionStatus(input: Parameters<typeof buildTaskStatusProjection>[0]) {
    return buildTaskStatusProjection(input).status;
  }

  it("projects draft flow without dispatch evidence as registered or materializing", () => {
    expect(projectionStatus({
      contract: contract({ status: "draft", telemetry: {} }),
      now,
    })).toBe("registered");

    expect(projectionStatus({
      contract: contract({
        status: "draft",
        delegate: { ...contract().delegate!, nativeBinding },
        telemetry: {},
      }),
      now,
    })).toBe("materializing");
  });

  it("projects dispatched but unspawned work as queued even with a native binding", () => {
    expect(projectionStatus({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: false } }),
      now,
    })).toBe("queued");

    expect(projectionStatus({
      contract: contract({
        delegate: { ...contract().delegate!, nativeBinding },
        telemetry: { dispatchExecuted: true, spawnExecuted: false },
      }),
      now,
    })).toBe("queued");
  });

  it("projects spawned work with fresh heartbeat or running contract status as running", () => {
    expect(projectionStatus({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true } }),
      heartbeatAt: "2026-04-25T00:09:00.000Z",
      now,
      staleAfterMs,
    })).toBe("running");

    expect(projectionStatus({
      contract: contract({
        status: "running",
        telemetry: { dispatchExecuted: true, spawnExecuted: true },
      }),
      heartbeatAt: now,
      now,
      staleAfterMs,
    })).toBe("running");
  });

  it("projects stale heartbeat as timed_out including the exact stale boundary", () => {
    expect(projectionStatus({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true } }),
      heartbeatAt: "2026-04-25T00:04:59.999Z",
      now,
      staleAfterMs,
    })).toBe("timed_out");

    expect(projectionStatus({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true } }),
      heartbeatAt: "2026-04-25T00:05:00.000Z",
      now,
      staleAfterMs,
    })).toBe("timed_out");
  });

  it("does not treat WorkContract updatedAt as execution progress evidence", () => {
    expect(projectionStatus({
      contract: contract({
        status: "running",
        telemetry: { dispatchExecuted: true, spawnExecuted: true },
        updatedAt: "2026-04-25T00:09:59.000Z",
      }),
      now,
      staleAfterMs,
    })).toBe("running");

    expect(buildTaskStatusProjection({
      contract: contract({
        status: "running",
        telemetry: { dispatchExecuted: true, spawnExecuted: true },
        updatedAt: "2026-04-25T00:09:59.000Z",
      }),
      now,
      staleAfterMs,
    }).statusReason).toBe("spawn_evidence_without_progress_timestamp");
  });

  it("projects final results awaiting delivery as deliverable_ready", () => {
    expect(projectionStatus({
      contract: contract({
        telemetry: {
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          deliveryStatus: "pending",
        },
      }),
      deliveryAcknowledged: false,
      now,
    })).toBe("deliverable_ready");

    expect(projectionStatus({
      contract: contract({ telemetry: { dispatchExecuted: true, spawnExecuted: true } }),
      finalResultExists: true,
      now,
    })).toBe("deliverable_ready");
  });

  it("projects acknowledged materialized results as completed", () => {
    expect(projectionStatus({
      contract: contract({
        telemetry: {
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          deliveryStatus: "pending",
        },
      }),
      deliveryAcknowledged: true,
      now,
    })).toBe("completed");
  });

  it("respects terminal failed and cancelled contract statuses over other evidence", () => {
    expect(projectionStatus({
      contract: contract({
        status: "failed",
        delegate: { ...contract().delegate!, nativeBinding },
        telemetry: {
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          deliveryStatus: "pending",
        },
      }),
      deliveryAcknowledged: true,
      finalResultExists: true,
      now,
    })).toBe("failed");

    expect(projectionStatus({
      contract: contract({
        status: "cancelled",
        delegate: { ...contract().delegate!, nativeBinding },
        telemetry: {
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          deliveryStatus: "pending",
        },
      }),
      deliveryAcknowledged: true,
      finalResultExists: true,
      now,
    })).toBe("canceled");
  });

  it("does not regress from running to queued after spawn evidence is added", () => {
    const dispatched = contract({ telemetry: { dispatchExecuted: true, spawnExecuted: false } });
    expect(projectionStatus({ contract: dispatched, now })).toBe("queued");

    const spawned = contract({
      ...dispatched,
      telemetry: { ...dispatched.telemetry, spawnExecuted: true },
    });
    expect(projectionStatus({
      contract: spawned,
      heartbeatAt: "2026-04-25T00:09:30.000Z",
      now,
      staleAfterMs,
    })).toBe("running");
  });
});
