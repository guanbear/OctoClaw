import { describe, expect, it } from "vitest";

import type { NativeStatusProjection } from "../state/native-status-projector.js";
import { buildRuntimeTaskProjection, runtimeStatusEvidence, type RuntimeTaskProjectionRecord } from "./runtime-task-projection.js";

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
    nativeKind: "spawn-child",
    agentRuntimeId: "acp-primary",
  };
}

describe("buildRuntimeTaskProjection", () => {
  it("projects canonical task view fields from task-state and native facts", () => {
    const record: RuntimeTaskProjectionRecord = {
      id: "wc-runtime-projection",
      route: "delegate",
      status: "delivered",
      title: "Runtime projection test",
      summary: "Runtime projection test",
      dispatchExecuted: true,
      spawnExecuted: true,
      runId: "run-1",
      childSessionKey: "child-1",
      model: "gpt-5.1-codex",
      worker_pool: "codex",
      completed_at: "2026-05-12T12:09:00.000Z",
      delivery_status: "delivered",
      delivery: {
        status: "delivered",
        messageId: "1778573724.032469",
        resultHash: "f1c04ee36a4f1a42",
      },
    };

    const view = buildRuntimeTaskProjection(record, {
      nowMs,
      nativeProjection: native("completed"),
    });

    expect(view).toMatchObject({
      taskId: "wc-runtime-projection",
      route: "delegate",
      status: "delivered",
      rawStatus: "completed",
      title: "Runtime projection test",
      model: "gpt-5.1-codex",
      backend: "codex",
      childSessionKey: "child-1",
      runId: "run-1",
      nativeKind: "spawn-child",
      agentRuntimeId: "acp-primary",
      statusReason: "delivered_with_ack",
      resultLocation: "delivered:1778573724.032469",
    });
  });

  it("does not display legacy child refs when native truth says direct", () => {
    const record: RuntimeTaskProjectionRecord = {
      id: "wc-runtime-direct",
      route: "delegate",
      status: "completed",
      title: "Native direct test",
      summary: "Native direct test",
      dispatchExecuted: true,
      spawnExecuted: true,
      runId: "legacy-run",
      childSessionKey: "agent:main:slack:channel:C123:subagent-old-label",
      completed_at: "2026-05-12T12:09:00.000Z",
      delivery: {
        status: "delivered",
        messageId: "1778573724.032469",
      },
    };

    const view = buildRuntimeTaskProjection(record, {
      nowMs,
      nativeProjection: {
        status: "completed",
        rawStatus: "completed",
        source: "run",
        reason: "resolved_by_openclaw_run_id",
        found: true,
        degraded: false,
        runId: "run-direct-1",
        nativeKind: "direct",
        agentRuntimeId: "acpx",
      },
    });

    expect(view).toMatchObject({
      nativeKind: "direct",
      agentRuntimeId: "acpx",
      runId: "run-direct-1",
      childSessionKey: "",
    });
  });

  it("does not treat transcript claims as spawn evidence for new tasks", () => {
    const evidence = runtimeStatusEvidence({
      id: "wc-no-native-spawn",
      route: "delegate",
      status: "running",
      dispatchExecuted: true,
      transcript: "I called sessions_spawn and delegated this task.",
      artifacts: {
        runtime_truth: {
          evidence: {
            transcript: "I called sessions_spawn and delegated this task.",
          },
        },
      },
    });

    expect(evidence).toMatchObject({
      hasDispatchEvidence: true,
      hasSpawnEvidence: false,
      runId: "",
      childSessionKey: "",
    });
  });

  it("does not treat assistant delivery text as delivered result evidence", () => {
    const view = buildRuntimeTaskProjection({
      id: "wc-no-native-delivery",
      route: "delegate",
      status: "completed",
      dispatchExecuted: true,
      spawnExecuted: true,
      runId: "run-1",
      assistantText: "I sent the final answer to Slack.",
      completed_at: "2026-05-12T12:09:00.000Z",
    }, {
      nowMs,
      nativeProjection: native("completed"),
    });

    expect(view).toMatchObject({
      status: "degraded",
      statusReason: "completed_without_result",
      resultLocation: "none",
    });
  });

  it("does not materialize a result from transcript text alone", () => {
    const view = buildRuntimeTaskProjection({
      id: "wc-transcript-only-result",
      route: "delegate",
      status: "completed",
      dispatchExecuted: true,
      spawnExecuted: true,
      runId: "run-1",
      transcript: "RESULT: done",
      artifacts: {
        runtime_truth: {
          transcript: "RESULT: done",
        },
      },
      completed_at: "2026-05-12T12:09:00.000Z",
    }, {
      nowMs,
      nativeProjection: native("completed"),
    });

    expect(view).toMatchObject({
      status: "degraded",
      statusReason: "completed_without_result",
      resultLocation: "none",
    });
  });
});
