import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelAllAckTimers,
  createAckTimers,
  shouldScheduleTier,
  DEFAULT_TIER_DELAYS_MS,
  getAckTierDelays,
} from "./ack-timing.js";

afterEach(() => {
  cancelAllAckTimers();
  vi.useRealTimers();
});

describe("ack-timing: shouldScheduleTier", () => {
  it("schedules tier 0 for reply", () => {
    expect(shouldScheduleTier("reply", 0)).toBe(true);
  });

  it("schedules tier 1 for reply", () => {
    expect(shouldScheduleTier("reply", 1)).toBe(true);
  });

  it("schedules tier 2 for reply", () => {
    expect(shouldScheduleTier("reply", 2)).toBe(true);
  });

  it("does not schedule tier 3 for reply", () => {
    expect(shouldScheduleTier("reply", 3)).toBe(false);
  });

  it("does not schedule for delegate", () => {
    expect(shouldScheduleTier("delegate", 0)).toBe(false);
    expect(shouldScheduleTier("delegate", 1)).toBe(false);
    expect(shouldScheduleTier("delegate", 2)).toBe(false);
  });

  it("does not schedule for observe", () => {
    expect(shouldScheduleTier("observe", 0)).toBe(false);
    expect(shouldScheduleTier("observe", 1)).toBe(false);
  });

  it("does not schedule for pre_route", () => {
    expect(shouldScheduleTier("pre_route", 0)).toBe(false);
  });
});

describe("ack-timing: DEFAULT_TIER_DELAYS_MS", () => {
  it("tier0 is 12 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[0]).toBe(12_000);
  });

  it("tier1 is 30 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[1]).toBe(30_000);
  });

  it("tier2 is 90 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[2]).toBe(90_000);
  });

  it("tier3 is 0 (unused)", () => {
    expect(DEFAULT_TIER_DELAYS_MS[3]).toBe(0);
  });
});

describe("ack-timing: getAckTierDelays", () => {
  it("disables tier delays for delegate", () => {
    expect(getAckTierDelays("delegate")).toEqual([0, 0, 0]);
  });

  it("keeps reply tier delays", () => {
    expect(getAckTierDelays("reply")).toEqual([12_000, 30_000, 90_000]);
  });
});

describe("ack-timing: createAckTimers", () => {
  it("does not schedule text ACK tiers when Slack partial streaming is enabled", () => {
    vi.useFakeTimers();
    const fired: number[] = [];

    createAckTimers({
      stateKey: "state-partial-stream",
      sessionKey: "session-partial-stream",
      routePhase: "reply",
      config: { tierDelaysMs: [1, 1, 1, 0] },
      channelStreaming: "partial",
      onTierFire: (result) => {
        fired.push(result.tier);
      },
    });

    vi.advanceTimersByTime(10);

    expect(fired).toEqual([]);
  });
});
