import { describe, expect, test } from "vitest";

import { ERROR_CODES, Errors, isOctoClawError } from "./index.js";

describe("Errors factory", () => {
  test("creates IM unresolvable target errors with registered code", () => {
    const error = Errors.imUnresolvableTarget("slack:C123:U456:ts789");

    expect(isOctoClawError(error)).toBe(true);
    expect(error.code).toBe(ERROR_CODES.IM_UNRESOLVABLE_TARGET);
    expect(error.userMessageZh).toContain("slack:C123:U456:ts789");
    expect(error.userMessageEn).toContain("slack:C123:U456:ts789");
  });

  test("creates judge timeout errors with registered code", () => {
    const error = Errors.judgeTimeout("qwen3:0.6b", 1500);

    expect(isOctoClawError(error)).toBe(true);
    expect(error.code).toBe(ERROR_CODES.JUDGE_TIMEOUT);
    expect(error.userMessageZh).toContain("qwen3:0.6b");
    expect(error.userMessageEn).toContain("1500ms");
  });

  test("creates OpenClaw not found errors with registered code", () => {
    const error = Errors.openclawNotFound();

    expect(isOctoClawError(error)).toBe(true);
    expect(error.code).toBe(ERROR_CODES.OPENCLAW_NOT_FOUND);
    expect(error.actionableHint).toBeDefined();
  });

  test("creates router snapshot stale errors with registered code", () => {
    const error = Errors.routerSnapshotStale("3d");

    expect(isOctoClawError(error)).toBe(true);
    expect(error.code).toBe(ERROR_CODES.ROUTER_SNAPSHOT_STALE);
    expect(error.userMessageEn).toContain("3d");
  });
});
