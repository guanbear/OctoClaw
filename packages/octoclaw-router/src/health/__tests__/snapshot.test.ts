import { describe, expect, it } from "vitest";
import { aggregateHealth, serializeHealthSnapshot } from "../snapshot.js";
import type { HealthEvent } from "../event.js";

const now = 1_778_900_000_000;

function event(modelKey: string, overrides: Partial<HealthEvent> = {}): HealthEvent {
  return {
    schemaVersion: "octoclaw.router.health_event/v1",
    ts: now,
    modelKey,
    source: "runtime",
    success: true,
    ...overrides,
  };
}

describe("aggregateHealth", () => {
  it("aggregates deterministic per-model health over the active window", () => {
    const events = [
      event("b/model", { ts: now - 2000, latencyMs: 100, success: true }),
      event("a/model", { ts: now - 4000, latencyMs: 200, success: false, errorCode: "500", timeout: true }),
      event("a/model", { ts: now - 3000, latencyMs: 100, success: true }),
      event("a/model", { ts: now - 2000, latencyMs: 300, success: false, errorCode: "TOOL", toolCallFailed: true }),
      event("a/model", { ts: now - 1000, latencyMs: 400, success: true }),
    ];

    const snapshot = aggregateHealth(events, now, { windowMs: 30 * 60_000, windowSize: 50 });

    expect(snapshot.windowMs).toBe(30 * 60_000);
    expect(snapshot.windowSize).toBe(50);
    expect(Object.keys(snapshot.models)).toEqual(["a/model", "b/model"]);
    expect(snapshot.models["a/model"]).toMatchObject({
      sampleCount: 4,
      windowStartedAt: now - 4000,
      windowEndedAt: now - 1000,
      recentFailureRate: 0.5,
      toolCallFailureRate: 0.25,
      timeoutRate: 0.25,
      p50LatencyMs: 200,
      p95LatencyMs: 400,
      lastErrorCodes: [
        { code: "500", count: 1 },
        { code: "TOOL", count: 1 },
      ],
      lastSuccessfulCallAt: now - 1000,
      lastFailedCallAt: now - 2000,
    });
    expect(serializeHealthSnapshot(snapshot)).toBe(serializeHealthSnapshot(aggregateHealth([...events].reverse(), now, { windowMs: 30 * 60_000, windowSize: 50 })));
  });

  it("caps each model to the latest windowSize samples", () => {
    const events = Array.from({ length: 60 }, (_, index) => event("a/model", {
      ts: now - (60 - index) * 1000,
      success: index >= 55,
      errorCode: index < 55 ? "500" : undefined,
    }));

    const snapshot = aggregateHealth(events, now, { windowMs: 30 * 60_000, windowSize: 50 });

    expect(snapshot.models["a/model"].sampleCount).toBe(50);
    expect(snapshot.models["a/model"].recentFailureRate).toBe(0.9);
  });

  it("keeps only the top three error codes", () => {
    const snapshot = aggregateHealth([
      event("a/model", { ts: now - 5000, success: false, errorCode: "D" }),
      event("a/model", { ts: now - 4000, success: false, errorCode: "C" }),
      event("a/model", { ts: now - 3000, success: false, errorCode: "B" }),
      event("a/model", { ts: now - 2000, success: false, errorCode: "A" }),
      event("a/model", { ts: now - 1000, success: false, errorCode: "A" }),
    ], now);

    expect(snapshot.models["a/model"].lastErrorCodes).toEqual([
      { code: "A", count: 2 },
      { code: "B", count: 1 },
      { code: "C", count: 1 },
    ]);
  });
});
