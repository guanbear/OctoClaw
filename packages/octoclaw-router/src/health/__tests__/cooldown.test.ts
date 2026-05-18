import { describe, expect, it } from "vitest";
import { evaluateCooldown } from "../cooldown.js";
import type { HealthEvent } from "../event.js";

const base = 1_778_900_000_000;

function event(overrides: Partial<HealthEvent> = {}): HealthEvent {
  return {
    schemaVersion: "octoclaw.router.health_event/v1",
    ts: base,
    modelKey: "cliproxyapi/gpt-5.5",
    source: "runtime",
    success: true,
    ...overrides,
  };
}

describe("evaluateCooldown", () => {
  it("cools down for recent 429 before other rules", () => {
    const result = evaluateCooldown({
      now: base,
      events: [
        event({ ts: base - 1000, success: false, errorCode: "TIMEOUT" }),
        event({ success: false, errorCode: "429" }),
      ],
    });

    expect(result).toEqual({
      cooldown: true,
      cooldownUntil: base + 10 * 60_000,
      reason: "rate_limit_429",
    });
  });

  it("cools down for provider quota 402 before waiting for failure-rate samples", () => {
    const result = evaluateCooldown({
      now: base,
      events: [event({ success: false, errorCode: "402" })],
    });

    expect(result).toEqual({
      cooldown: true,
      cooldownUntil: base + 10 * 60_000,
      reason: "provider_quota_402",
    });
  });

  it("cools down for failed probe without requiring ten samples", () => {
    expect(evaluateCooldown({
      now: base,
      events: [event({ source: "probe", success: false, errorCode: "PROBE_HTTP_ERROR" })],
    })).toEqual({
      cooldown: true,
      cooldownUntil: base + 30 * 60_000,
      reason: "probe_failure",
    });
  });

  it("cools down when recent failure rate reaches twenty percent", () => {
    const events = Array.from({ length: 10 }, (_, index) => event({
      ts: base - (10 - index) * 1000,
      success: index >= 2,
      errorCode: index < 2 ? "500" : undefined,
    }));

    expect(evaluateCooldown({ now: base, events })).toMatchObject({
      cooldown: true,
      cooldownUntil: base + 30 * 60_000,
      reason: "high_failure_rate",
    });
  });

  it("cools down when p95 latency drifts past baseline", () => {
    const events = Array.from({ length: 10 }, (_, index) => event({
      ts: base - (10 - index) * 1000,
      latencyMs: index === 9 ? 3000 : 1000,
    }));

    expect(evaluateCooldown({ now: base, events, baselineP95Ms: 1000 })).toMatchObject({
      cooldown: true,
      cooldownUntil: base + 15 * 60_000,
      reason: "high_p95_drift",
    });
  });

  it("does not cool down for sparse runtime failures", () => {
    expect(evaluateCooldown({
      now: base,
      events: [event({ success: false, errorCode: "500" })],
    })).toEqual({ cooldown: false });
  });

  it("recovers when the latest event is a successful call", () => {
    expect(evaluateCooldown({
      now: base,
      events: [
        event({ ts: base - 1000, success: false, errorCode: "429" }),
        event({ ts: base, success: true }),
      ],
    })).toEqual({ cooldown: false });
  });
});
