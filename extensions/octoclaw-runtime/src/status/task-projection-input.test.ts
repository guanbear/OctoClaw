import { describe, expect, it } from "vitest";

import { buildTaskProjectionInput, projectionCacheFromRecord } from "./task-projection-input.js";

describe("task projection input", () => {
  it("keeps native lookup fields separate from cache display metadata", () => {
    const input = buildTaskProjectionInput({
      native: {
        ctx: { runtime: true },
        sessionKey: "session-1",
        workContractId: "wc-1",
        openclawRunId: "run-native",
        openclawTaskId: "task-native",
        openclawFlowId: "flow-native",
        childSessionKey: "child-native",
      },
      cache: {
        status: "completed",
        rawStatus: "completed",
        summary: "stale cache summary",
      },
    });

    expect(input).toMatchObject({
      sessionKey: "session-1",
      workContractId: "wc-1",
      openclawRunId: "run-native",
      cache: {
        status: "completed",
        summary: "stale cache summary",
      },
    });
  });

  it("extracts cache metadata from task records without manufacturing native ids", () => {
    expect(projectionCacheFromRecord({
      status: "failed",
      raw_status: "failed",
      summary: "old task-state cache",
      runId: "run-display-only",
    })).toEqual({
      status: "failed",
      rawStatus: "failed",
      summary: "old task-state cache",
    });
  });
});
