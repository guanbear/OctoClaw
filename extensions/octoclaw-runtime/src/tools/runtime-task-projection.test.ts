import { describe, expect, it } from "vitest";

import type { NativeStatusProjection } from "../state/native-status-projector.js";
import { buildRuntimeTaskProjection, type RuntimeTaskProjectionRecord } from "./runtime-task-projection.js";

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

describe("buildRuntimeTaskProjection", () => {
  it("projects canonical task view fields from task-state and native facts", () => {
    const record: RuntimeTaskProjectionRecord = {
      id: "wc-runtime-projection",
      route: "delegate",
      status: "completed",
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
      status: "completed",
      rawStatus: "completed",
      title: "Runtime projection test",
      model: "gpt-5.1-codex",
      backend: "codex",
      childSessionKey: "child-1",
      runId: "run-1",
      statusReason: "completed_with_result",
      resultLocation: "delivered:1778573724.032469",
    });
  });
});
