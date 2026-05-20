import { beforeEach, describe, expect, it, vi } from "vitest";

const captureTmuxEvidenceMock = vi.hoisted(() => vi.fn());
const readTaskStateRecordsMock = vi.hoisted(() => vi.fn((): unknown[] => []));
const pruneTaskStateCacheMock = vi.hoisted(() => vi.fn(() => ({ archived: 0, deletedArchiveEntries: 0, skipped: false, reason: "" })));
const readStatusMock = vi.hoisted(() => vi.fn());
const recordPolicyReplayMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../runtime-ledger/tmux-evidence.js", () => ({
  captureTmuxEvidence: captureTmuxEvidenceMock,
  isTmuxEvidenceEnabled: () => true,
}));

vi.mock("../state/task-state-store.js", () => ({
  readTaskStateDocumentDetailed: () => ({ status: "ok", document: { tasks: [] } }),
  readTaskStateRecords: readTaskStateRecordsMock,
}));

vi.mock("../state/task-state-retention.js", () => ({
  pruneTaskStateCache: pruneTaskStateCacheMock,
  readArchivedTaskState: () => [],
}));

vi.mock("../runtime-ledger/shadow.js", () => ({
  resolveRuntimeLedgerMode: () => "off",
}));

vi.mock("../replay/replay.js", () => ({
  recordPolicyReplay: recordPolicyReplayMock,
}));

vi.mock("../runtime-host/openclaw-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-host/openclaw-adapter.js")>("../runtime-host/openclaw-adapter.js");
  return {
    ...actual,
    createOpenClawRuntimeAdapter: () => ({
      host: "openclaw",
      readStatus: readStatusMock,
      readDelivery: async () => ({ found: false, delivered: false, degraded: false, reason: "test" }),
      readFallbacks: async () => ({ status: "unavailable", fallbackRuntimeIds: [], source: "none", observedAt: "2026-05-12T00:00:00.000Z" }),
    }),
  };
});

import type { NativeStatusProjection } from "../state/native-status-projector.js";
import { buildNativeStatusPanelOutput, buildRuntimeStatusTaskView, type RuntimeTaskStateRecord } from "./runtime-status.js";

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
    readTaskStateRecordsMock.mockReset();
    readTaskStateRecordsMock.mockReturnValue([]);
    pruneTaskStateCacheMock.mockReset();
    pruneTaskStateCacheMock.mockReturnValue({ archived: 0, deletedArchiveEntries: 0, skipped: false, reason: "" });
    readStatusMock.mockReset();
    recordPolicyReplayMock.mockClear();
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

  it("NTR-P4-003: status panel reads native truth through the runtime adapter", async () => {
    readTaskStateRecordsMock.mockReturnValue([
      task({
        runId: "run-1",
        flowId: "flow-1",
        childSessionKey: "child-1",
        nativeTaskId: "task-1",
        status: "running",
      }),
    ]);
    readStatusMock.mockResolvedValue({
      found: true,
      degraded: false,
      status: "running",
      nativeStatus: "running",
      rawStatus: "running",
      source: "run",
      reason: "resolved_by_openclaw_run_id",
      runId: "run-1",
      flowId: "flow-1",
      taskId: "task-1",
      childSessionKey: "child-1",
      nativeKind: "spawn-child",
      agentRuntimeId: "acp-primary",
    });

    const output = await buildNativeStatusPanelOutput("raw", "plain", { runtimeCtx: true });

    expect(readStatusMock).toHaveBeenCalledWith(expect.objectContaining({
      ctx: { runtimeCtx: true },
      runId: "run-1",
      flowId: "flow-1",
      taskId: "task-1",
      childSessionKey: "child-1",
    }));
    expect(output.text).toContain("native=spawn-child/acp-primary");
    expect(output.text).toContain("child=child-1/run-1");
    expect(recordPolicyReplayMock).not.toHaveBeenCalledWith(
      "legacy_heuristic_fallback_used",
      expect.anything(),
    );
  });

  it("scopes Slack status panel records to the current Slack channel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:10:00.000Z"));
    readTaskStateRecordsMock.mockReturnValue([
      task({
        id: "wc-current-channel",
        workContractId: "wc-current-channel",
        title: "Current channel task",
        summary: "Current channel task",
        sessionKey: "agent:main:slack:channel:CSTATUSA:thread:171.000001",
        session_key: "agent:main:slack:channel:CSTATUSA:thread:171.000001",
        status: "completed",
        completed_at: "2026-05-12T12:09:00.000Z",
        delivery: {
          status: "delivered",
          messageId: "171.000101",
        },
      }),
      task({
        id: "wc-other-channel",
        workContractId: "wc-other-channel",
        title: "Other channel task should not leak",
        summary: "Other channel task should not leak",
        sessionKey: "agent:main:slack:channel:CSTATUSB:thread:172.000002",
        session_key: "agent:main:slack:channel:CSTATUSB:thread:172.000002",
        status: "completed",
        completed_at: "2026-05-12T12:09:00.000Z",
        delivery: {
          status: "delivered",
          messageId: "172.000202",
        },
      }),
    ]);
    readStatusMock.mockResolvedValue({
      found: true,
      degraded: false,
      status: "completed",
      nativeStatus: "completed",
      rawStatus: "completed",
      source: "run",
      reason: "resolved_by_openclaw_run_id",
      nativeKind: "spawn-child",
      agentRuntimeId: "acp-primary",
    });

    try {
      const output = await buildNativeStatusPanelOutput("anchors", "slack", {
        sessionKey: "agent:main:slack:channel:CSTATUSA:thread:179.000009",
        channelId: "slack",
      });

      expect(output.text).toContain("Current channel task");
      expect(output.text).not.toContain("Other channel task should not leak");
      expect(readStatusMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
