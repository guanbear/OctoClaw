import { describe, expect, it } from "vitest";
import { computeFastReplyMetrics } from "./index.js";

describe("fast reply instrumentation", () => {
  it("populates ack_ms only when only ackSentAt is present", () => {
    expect(computeFastReplyMetrics({ routeDecisionStartedAt: 100, ackSentAt: 145 })).toEqual({
      ack_ms: 45,
    });
  });

  it("populates both metrics when both timestamps exist", () => {
    expect(computeFastReplyMetrics({ routeDecisionStartedAt: 100, ackSentAt: 140, replyCompletedAt: 230 })).toEqual({
      ack_ms: 40,
      total_latency_ms: 130,
    });
  });

  it("returns empty metrics when timestamps are absent", () => {
    expect(computeFastReplyMetrics({ routeDecisionStartedAt: 100 })).toEqual({});
  });

  it("clamps negative time differences to zero", () => {
    expect(computeFastReplyMetrics({ routeDecisionStartedAt: 100, ackSentAt: 90, replyCompletedAt: 80 })).toEqual({
      ack_ms: 0,
      total_latency_ms: 0,
    });
  });
});
