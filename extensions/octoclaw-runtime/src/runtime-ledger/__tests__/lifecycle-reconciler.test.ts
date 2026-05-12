import { describe, expect, it } from "vitest";
import {
  buildCompactParentPacket,
  reduceCanonicalStatus,
  type LifecycleReconcileInput,
} from "../lifecycle-reconciler.js";

function defaultInput(overrides: Partial<LifecycleReconcileInput> = {}): LifecycleReconcileInput {
  return {
    currentStatus: "running",
    nativeStatus: "running",
    hasCompletionReceipt: false,
    hasArtifactRef: false,
    hasReportPath: false,
    hasResultSummary: false,
    hasDeliveryAck: false,
    expectedAt: null,
    hardTimeoutAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    tmuxEvidence: null,
    now: new Date().toISOString(),
    ...overrides,
  };
}

const now = "2026-05-12T12:00:00.000Z";
const past = "2026-05-12T11:59:00.000Z";
const future = "2026-05-12T12:01:00.000Z";
const recent = "2026-05-12T11:59:30.000Z";
const stale = "2026-05-12T11:58:30.000Z";

describe("reduceCanonicalStatus", () => {
  it('native failed → status "failed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "failed" }))).toEqual({
      status: "failed",
      reason: "native_failed",
      suggestedAction: "inspect",
    });
  });

  it('native timed_out → status "timed_out"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "timed_out" }))).toEqual({
      status: "timed_out",
      reason: "native_timed_out",
      suggestedAction: "inspect",
    });
  });

  it('native completed + receipt → status "completed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed", hasCompletionReceipt: true })).status).toBe(
      "completed",
    );
  });

  it('native completed + artifact ref → status "completed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed", hasArtifactRef: true })).status).toBe(
      "completed",
    );
  });

  it('native completed + report path → status "completed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed", hasReportPath: true })).status).toBe(
      "completed",
    );
  });

  it('native completed + result summary → status "completed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed", hasResultSummary: true })).status).toBe(
      "completed",
    );
  });

  it('native completed + delivery ack → status "completed"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed", hasDeliveryAck: true })).status).toBe(
      "completed",
    );
  });

  it('native completed + no result evidence → status "degraded", reason "completed_without_result"', () => {
    expect(reduceCanonicalStatus(defaultInput({ nativeStatus: "completed" }))).toEqual({
      status: "degraded",
      reason: "completed_without_result",
      suggestedAction: "inspect",
    });
  });

  it('hard timeout passed + no live evidence → status "timed_out"', () => {
    expect(
      reduceCanonicalStatus(defaultInput({ now, hardTimeoutAt: past, nativeStatus: "missing", lastHeartbeatAt: stale })),
    ).toEqual({
      status: "timed_out",
      reason: "hard_timeout_no_live_evidence",
      suggestedAction: "stop",
    });
  });

  it('hard timeout passed + native still running → status "running_slow"', () => {
    expect(reduceCanonicalStatus(defaultInput({ now, hardTimeoutAt: past, nativeStatus: "running" }))).toEqual({
      status: "running_slow",
      reason: "hard_timeout_live_evidence",
      suggestedAction: "inspect",
    });
  });

  it('hard timeout passed + tmux alive + output changed → status "running_slow"', () => {
    expect(
      reduceCanonicalStatus(
        defaultInput({
          now,
          hardTimeoutAt: past,
          nativeStatus: "missing",
          tmuxEvidence: {
            enabled: true,
            available: true,
            alive: true,
            outputChangedSinceLastCheck: true,
            lastOutputAt: recent,
          },
        }),
      ),
    ).toEqual({
      status: "running_slow",
      reason: "hard_timeout_live_evidence",
      suggestedAction: "inspect",
    });
  });

  it('expected deadline passed + tmux alive active → status "running_slow"', () => {
    expect(
      reduceCanonicalStatus(
        defaultInput({
          now,
          expectedAt: past,
          nativeStatus: "missing",
          tmuxEvidence: {
            enabled: true,
            available: true,
            alive: true,
            outputChangedSinceLastCheck: true,
            lastOutputAt: recent,
          },
        }),
      ),
    ).toEqual({
      status: "running_slow",
      reason: "expected_deadline_passed_live_output",
      suggestedAction: "wait",
    });
  });

  it('expected deadline passed + native running + recent heartbeat → status "running_slow"', () => {
    expect(
      reduceCanonicalStatus(defaultInput({ now, expectedAt: past, nativeStatus: "running", lastHeartbeatAt: recent })),
    ).toEqual({
      status: "running_slow",
      reason: "expected_deadline_passed_live_output",
      suggestedAction: "wait",
    });
  });

  it('expected deadline passed + tmux alive idle → status "stalled"', () => {
    expect(
      reduceCanonicalStatus(
        defaultInput({
          now,
          expectedAt: past,
          nativeStatus: "missing",
          tmuxEvidence: {
            enabled: true,
            available: true,
            alive: true,
            outputChangedSinceLastCheck: false,
            lastOutputAt: stale,
          },
        }),
      ),
    ).toEqual({
      status: "stalled",
      reason: "expected_deadline_passed_no_progress",
      suggestedAction: "inspect",
    });
  });

  it('expected deadline passed + native running + no progress → status "stalled"', () => {
    expect(
      reduceCanonicalStatus(defaultInput({ now, expectedAt: past, nativeStatus: "running", lastHeartbeatAt: stale })),
    ).toEqual({
      status: "stalled",
      reason: "expected_deadline_passed_no_progress",
      suggestedAction: "inspect",
    });
  });

  it('native running + no deadlines passed → status "running"', () => {
    expect(reduceCanonicalStatus(defaultInput({ now, expectedAt: future, hardTimeoutAt: future }))).toEqual({
      status: "running",
      reason: "fresh_running",
      suggestedAction: "wait",
    });
  });

  it('queued status + no spawn evidence → status "queued"', () => {
    expect(reduceCanonicalStatus(defaultInput({ currentStatus: "materializing", nativeStatus: "missing" }))).toEqual({
      status: "queued",
      reason: "no_spawn_evidence",
      suggestedAction: "wait",
    });
  });

  it("does not preserve completed-like status without result evidence", () => {
    expect(reduceCanonicalStatus(defaultInput({ currentStatus: "deliverable_ready", nativeStatus: "missing" }))).toEqual({
      status: "degraded",
      reason: "completed_without_result",
      suggestedAction: "inspect",
    });
  });

  it("preserves completed-like status when result evidence exists", () => {
    expect(reduceCanonicalStatus(defaultInput({ currentStatus: "deliverable_ready", nativeStatus: "missing", hasArtifactRef: true }))).toEqual({
      status: "completed",
      reason: "completed_with_result",
      suggestedAction: "deliver",
    });
  });

  it("tmux disabled: reducer still works with native-only evidence", () => {
    expect(
      reduceCanonicalStatus(
        defaultInput({
          now,
          nativeStatus: "running",
          hardTimeoutAt: past,
          tmuxEvidence: {
            enabled: false,
            available: false,
            alive: false,
            outputChangedSinceLastCheck: false,
            lastOutputAt: null,
          },
        }),
      ).status,
    ).toBe("running_slow");
  });

  it("tmux missing: reducer still works", () => {
    expect(
      reduceCanonicalStatus(
        defaultInput({
          now,
          expectedAt: past,
          nativeStatus: "running",
          tmuxEvidence: {
            enabled: true,
            available: true,
            alive: false,
            outputChangedSinceLastCheck: false,
            lastOutputAt: null,
          },
        }),
      ).status,
    ).toBe("stalled");
  });

  it("hard timeout passed + recent heartbeat within 60s → running_slow (live evidence)", () => {
    expect(
      reduceCanonicalStatus(defaultInput({ now, hardTimeoutAt: past, nativeStatus: "missing", lastHeartbeatAt: recent })),
    ).toEqual({
      status: "running_slow",
      reason: "hard_timeout_live_evidence",
      suggestedAction: "inspect",
    });
  });

  it("expected deadline passed + recent progress within 60s → running_slow", () => {
    expect(
      reduceCanonicalStatus(defaultInput({ now, expectedAt: past, nativeStatus: "missing", lastProgressAt: recent })),
    ).toEqual({
      status: "running_slow",
      reason: "expected_deadline_passed_live_output",
      suggestedAction: "wait",
    });
  });
});

describe("buildCompactParentPacket", () => {
  it("buildCompactParentPacket includes correct evidence classifications", () => {
    const input = defaultInput({
      now,
      workContractId: "wc_123",
      attemptId: "attempt_1",
      childRunId: "run_1",
      childSessionKey: "session_1",
      summary: "done",
      resultLocation: "result.json",
      artifacts: ["artifact_1"],
      nativeStatus: "completed",
      hasCompletionReceipt: true,
      hasArtifactRef: true,
      expectedAt: past,
      hardTimeoutAt: future,
      tmuxEvidence: {
        enabled: true,
        available: true,
        alive: true,
        outputChangedSinceLastCheck: true,
        lastOutputAt: recent,
      },
    });
    const result = reduceCanonicalStatus(input);

    expect(buildCompactParentPacket(result, input)).toEqual({
      workContractId: "wc_123",
      attemptId: "attempt_1",
      status: "completed",
      reason: "completed_with_result",
      summary: "done",
      resultLocation: "result.json",
      artifacts: ["artifact_1"],
      nativeStatus: "completed",
      childRunId: "run_1",
      childSessionKey: "session_1",
      expectedAt: past,
      hardTimeoutAt: future,
      evidence: {
        native: "completed",
        receipt: "present",
        artifact: "present",
        tmux: "alive_active",
      },
      suggestedAction: "deliver",
    });
  });
});
