import { describe, expect, it } from "vitest";

import { validateJudgeOutputDetailed } from "@octoclaw/policy/judge-schema";

describe("judge output validation", () => {
  it("rejects delegate output without active four-field schema", () => {
    const result = validateJudgeOutputDetailed({ route: "delegate" });

    expect(result).toEqual({
      valid: false,
      degraded: false,
      degradedReasons: [],
    });
  });

  it("rejects minimal delegate output without complexity fields", () => {
    const result = validateJudgeOutputDetailed({ route: "delegate", confidence: 0.7 });

    expect(result).toEqual({
      valid: false,
      degraded: false,
      degradedReasons: [],
    });
  });

  it("accepts active four-field delegate output as authoritative", () => {
    const result = validateJudgeOutputDetailed({
      route: "delegate",
      confidence: 0.7,
      complexity: "normal",
      complexity_confidence: 0.74,
    });

    expect(result).toEqual({
      valid: true,
      degraded: false,
      degradedReasons: [],
    });
  });

  it("rejects delegate output with invalid confidence", () => {
    const result = validateJudgeOutputDetailed({
      route: "delegate",
      confidence: "invalid",
    });

    expect(result).toEqual({
      valid: false,
      degraded: false,
      degradedReasons: [],
    });
  });

  it("accepts active four-field reply output", () => {
    const result = validateJudgeOutputDetailed({
      route: "reply",
      confidence: 0.8,
      complexity: "simple",
      complexity_confidence: 0.9,
    });

    expect(result).toEqual({
      valid: true,
      degraded: false,
      degradedReasons: [],
    });
  });
});
