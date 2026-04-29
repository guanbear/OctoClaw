import { describe, expect, it } from "vitest";
import { buildRuntimeDeadlines, hasDeadlineExpired } from "./deadlines.js";

describe("runtime deadlines", () => {
  it("builds five deadlines in temporal order", () => {
    const deadlines = buildRuntimeDeadlines({
      queuedAt: "2026-04-18T13:00:00.000Z",
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 3_000,
      runtimeMs: 4_000,
      deliveryMs: 5_000,
    });

    expect(deadlines).toEqual({
      queueDeadline: "2026-04-18T13:00:01.000Z",
      startDeadline: "2026-04-18T13:00:02.000Z",
      progressDeadline: "2026-04-18T13:00:03.000Z",
      runtimeDeadline: "2026-04-18T13:00:04.000Z",
      deliveryDeadline: "2026-04-18T13:00:05.000Z",
    });

    expect(new Date(deadlines.queueDeadline).getTime()).toBeLessThan(new Date(deadlines.startDeadline).getTime());
    expect(new Date(deadlines.startDeadline).getTime()).toBeLessThan(new Date(deadlines.progressDeadline).getTime());
    expect(new Date(deadlines.progressDeadline).getTime()).toBeLessThan(new Date(deadlines.runtimeDeadline).getTime());
    expect(new Date(deadlines.runtimeDeadline).getTime()).toBeLessThan(new Date(deadlines.deliveryDeadline).getTime());
  });

  it("reports future deadlines as active and past deadlines as expired", () => {
    expect(hasDeadlineExpired("2026-04-18T13:00:10.000Z", new Date("2026-04-18T13:00:09.000Z"))).toBe(false);
    expect(hasDeadlineExpired("2026-04-18T13:00:10.000Z", new Date("2026-04-18T13:00:10.000Z"))).toBe(true);
  });

  it("supports checking each deadline type independently", () => {
    const deadlines = buildRuntimeDeadlines({
      queuedAt: "2026-04-18T13:00:00.000Z",
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 3_000,
      runtimeMs: 4_000,
      deliveryMs: 5_000,
    });
    const checkpoints = [
      { name: "queueDeadline", now: "2026-04-18T13:00:01.000Z", expired: true },
      { name: "startDeadline", now: "2026-04-18T13:00:01.500Z", expired: false },
      { name: "progressDeadline", now: "2026-04-18T13:00:03.500Z", expired: true },
      { name: "runtimeDeadline", now: "2026-04-18T13:00:03.500Z", expired: false },
      { name: "deliveryDeadline", now: "2026-04-18T13:00:06.000Z", expired: true },
    ] as const;

    for (const checkpoint of checkpoints) {
      expect(hasDeadlineExpired(deadlines[checkpoint.name], new Date(checkpoint.now))).toBe(checkpoint.expired);
    }
  });
});
