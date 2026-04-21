import { describe, expect, it } from "vitest";
import {
  shouldScheduleTier,
  DEFAULT_TIER_DELAYS_MS,
} from "./ack-timing.js";

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
  it("tier0 is 18 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[0]).toBe(18_000);
  });

  it("tier1 is 45 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[1]).toBe(45_000);
  });

  it("tier2 is 120 seconds", () => {
    expect(DEFAULT_TIER_DELAYS_MS[2]).toBe(120_000);
  });

  it("tier3 is 0 (unused)", () => {
    expect(DEFAULT_TIER_DELAYS_MS[3]).toBe(0);
  });
});
