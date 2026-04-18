import { describe, expect, it } from "vitest";
import { buildFastReplyAck } from "./index.js";

describe("fast reply ack", () => {
  it("builds ack payload from a valid decision", () => {
    const payload = buildFastReplyAck(
      "latency",
      { required: true, text: "Working on it" },
      { routeDecisionStartedAt: 100, ackSentAt: 140 },
    );

    expect(payload).toEqual({
      mode: "latency",
      required: true,
      text: "Working on it",
      metrics: { ack_ms: 40 },
    });
  });

  it("ack template text stays non-empty after normalization", () => {
    const payload = buildFastReplyAck(
      "pre_dispatch",
      { required: true, text: "  Acknowledged  " },
      { routeDecisionStartedAt: 0 },
    );

    expect(payload.text).toBe("Acknowledged");
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.required).toBe(true);
  });

  it("propagates mode correctly", () => {
    expect(buildFastReplyAck("pre_dispatch", { required: true, text: "Ack" }, { routeDecisionStartedAt: 0 }).mode).toBe("pre_dispatch");
    expect(buildFastReplyAck("latency", { required: true, text: "Ack" }, { routeDecisionStartedAt: 0 }).mode).toBe("latency");
  });
});
