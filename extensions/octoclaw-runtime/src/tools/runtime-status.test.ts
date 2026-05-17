import { beforeEach, describe, expect, it, vi } from "vitest";

const captureTmuxEvidenceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-ledger/tmux-evidence.js", () => ({
  captureTmuxEvidence: captureTmuxEvidenceMock,
  isTmuxEvidenceEnabled: () => true,
}));

import type { NativeStatusProjection } from "../state/native-status-projector.js";
import { buildRuntimeStatusTaskView, type RuntimeTaskStateRecord } from "./runtime-status.js";

const nowMs = Date.parse("2026-05-12T12:10:00.000Z");

function native(status: NativeStatusProjection["status"]): NativeStatusProjection {
  return {
    status,
    rawStatus: status,
    source: "run",
    reason: "resolved_by_openclaw_run_id",
    found: true,
    degraded: false,
    runId: "run-1",
  };
}

function task(overrides: Partial<RuntimeTaskStateRecord> = {}): RuntimeTaskStateRecord {
  return {
    id: "wc-runtime-status",
    workContractId: "wc-runtime-status",
    route: "delegate",
    status: "running",
    title: "Runtime status test",
    summary: "Runtime status test",
    dispatchExecuted: true,
    spawnExecuted: true,
    runId: "run-1",
    childSessionKey: "child-1",
    created_at: "2026-05-12T12:00:00.000Z",
    spawned_at: "2026-05-12T12:00:05.000Z",
    started_at: "2026-05-12T12:00:10.000Z",
    updated_at: "2026-05-12T12:00:10.000Z",
    ...overrides,
  };
}

describe("runtime status lifecycle projection", () => {
  beforeEach(() => {
    captureTmuxEvidenceMock.mockReset();
  });

  it("marks native completed without result evidence as degraded", () => {
    const view = buildRuntimeStatusTaskView(task({ status: "completed" }), nowMs, native("completed"));

    expect(view.status).toBe("degraded");
    expect(view.statusReason).toBe("completed_without_result");
    expect(view.resultLocation).toBe("none");
  });

  it("keeps completed status when result evidence exists", () => {
    const view = buildRuntimeStatusTaskView(
      task({
        status: "completed",
        report_path: "/tmp/wc-runtime-status-report.md",
        completed_at: "2026-05-12T12:09:00.000Z",
      }),
      nowMs,
      native("completed"),
    );

    expect(view.status).toBe("completed");
    expect(view.statusReason).toBe("completed_with_result");
    expect(view.resultLocation).toBe("/tmp/wc-runtime-status-report.md");
  });

  it("uses native announce delivery evidence as delivered result evidence", () => {
    const view = buildRuntimeStatusTaskView(
      task({
        status: "completed",
        completed_at: "2026-05-12T12:09:00.000Z",
        delivery_status: "delivered",
        delivery: {
          status: "delivered",
          resultHash: "f1c04ee36a4f1a42",
          messageId: "1778573724.032469",
        },
      }),
      nowMs,
      native("completed"),
    );

    expect(view.status).toBe("delivered");
    expect(view.statusReason).toBe("delivered_with_ack");
    expect(view.resultLocation).toBe("delivered:1778573724.032469");
  });

  it("marks a native-running task past expected deadline without progress as stalled", () => {
    const view = buildRuntimeStatusTaskView(task(), nowMs, native("running"));

    expect(view.status).toBe("stalled");
    expect(view.statusReason).toBe("expected_deadline_passed_no_progress");
  });

  it("marks a native-running task past expected deadline with recent heartbeat as running_slow", () => {
    const view = buildRuntimeStatusTaskView(
      task({ lastHeartbeatAt: "2026-05-12T12:09:45.000Z" }),
      nowMs,
      native("running"),
    );

    expect(view.status).toBe("running_slow");
    expect(view.statusReason).toBe("expected_deadline_passed_live_output");
  });

  it("uses tmux pane evidence when a task records a tmux mapping", () => {
    captureTmuxEvidenceMock.mockReturnValue({
      enabled: true,
      available: true,
      alive: true,
      session: "octo",
      pane: "%1",
      outputChangedSinceLastCheck: true,
      capturedAt: "2026-05-12T12:10:00.000Z",
    });

    const view = buildRuntimeStatusTaskView(
      task({
        artifacts: {
          runtime_truth: {
            tmux: {
              session: "octo",
              pane: "%1",
            },
          },
        },
      }),
      nowMs,
      native("running"),
    );

    expect(captureTmuxEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({ session: "octo", pane: "%1" }));
    expect(view.status).toBe("running_slow");
    expect(view.statusReason).toBe("expected_deadline_passed_live_output");
  });

  it("does not query tmux when no pane mapping exists", () => {
    buildRuntimeStatusTaskView(task(), nowMs, native("running"));

    expect(captureTmuxEvidenceMock).not.toHaveBeenCalled();
  });

  it("keeps native registry missing visible as lost before hard timeout", () => {
    const view = buildRuntimeStatusTaskView(
      task(),
      nowMs,
      {
        status: "lost",
        rawStatus: "missing",
        source: "none",
        reason: "native_id_known_but_registry_missing",
        found: false,
        degraded: true,
        runId: "run-1",
      },
    );

    expect(view.status).toBe("lost");
    expect(view.statusReason).toBe("native_accepted_result_not_reconciled");
  });

  it("does not treat delivery_status sent as delivered result evidence", () => {
    const view = buildRuntimeStatusTaskView(
      task({
        status: "completed",
        completed_at: "2026-05-12T12:09:00.000Z",
        delivery_status: "sent",
      }),
      nowMs,
      native("completed"),
    );

    expect(view.status).not.toBe("delivered");
    expect(view.statusReason).not.toBe("delivered_with_ack");
  });
});
