import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createAckTimers,
  cancelAckTimers,
  cancelAllAckTimers,
  ackTimerStateForKey,
  DEFAULT_TIER_DELAYS_MS,
  type AckTimerResult,
} from "./ack-timing.js";

describe("ack-timing: createAckTimers integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelAllAckTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules reply tier callbacks at 18s, 45s, 120s", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "test-state",
      sessionKey: "slack:default:channel:C123",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(17_999);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].tier).toBe(0);
    expect(fired[0].stage).toBe("tool_still_working");
    expect(fired[0].routePhase).toBe("reply");

    vi.advanceTimersByTime(45_000 - 18_000 - 1);
    expect(fired).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(2);
    expect(fired[1].tier).toBe(1);
    expect(fired[1].stage).toBe("tool_ask_continue");

    vi.advanceTimersByTime(120_000 - 45_000 - 1);
    expect(fired).toHaveLength(2);

    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(3);
    expect(fired[2].tier).toBe(2);
    expect(fired[2].stage).toBe("tool_suggest_stop");
  });

  it("does not schedule timers for delegate route", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "test-delegate",
      sessionKey: "slack:default:channel:C456",
      routePhase: "delegate",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(200_000);
    expect(fired).toHaveLength(0);
  });

  it("does not schedule timers for observe route", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "test-observe",
      sessionKey: "slack:default:channel:C789",
      routePhase: "observe",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(200_000);
    expect(fired).toHaveLength(0);
  });

  it("cancels timers when cancelAckTimers is called", () => {
    const fired: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "test-cancel",
      sessionKey: "slack:default:channel:C000",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired.push(r),
    });

    vi.advanceTimersByTime(10_000);
    cancelAckTimers("test-cancel");

    vi.advanceTimersByTime(200_000);
    expect(fired).toHaveLength(0);
  });

  it("cancels previous timers when re-creating for same stateKey", () => {
    const fired1: AckTimerResult[] = [];
    const fired2: AckTimerResult[] = [];
    createAckTimers({
      stateKey: "test-replace",
      sessionKey: "slack:default:channel:C111",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired1.push(r),
    });

    vi.advanceTimersByTime(10_000);

    createAckTimers({
      stateKey: "test-replace",
      sessionKey: "slack:default:channel:C111",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: (r) => fired2.push(r),
    });

    vi.advanceTimersByTime(20_000);
    expect(fired1).toHaveLength(0);
    expect(fired2).toHaveLength(1);
    expect(fired2[0].tier).toBe(0);
  });

  it("marks tier as fired in state", () => {
    createAckTimers({
      stateKey: "test-fired",
      sessionKey: "slack:default:channel:C222",
      routePhase: "reply",
      config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
      onTierFire: () => {},
    });

    const state0 = ackTimerStateForKey("test-fired");
    expect(state0?.tier0Fired).toBe(false);

    vi.advanceTimersByTime(18_001);
    const state1 = ackTimerStateForKey("test-fired");
    expect(state1?.tier0Fired).toBe(true);
    expect(state1?.tier1Fired).toBe(false);
  });
});
