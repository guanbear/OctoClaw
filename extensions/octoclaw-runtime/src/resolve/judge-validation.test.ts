import { describe, expect, it } from "vitest";

import { validateJudgeOutputDetailed } from "@octoclaw/policy/judge-schema";

describe("judge output validation", () => {
  it("marks minimal delegate output as degraded", () => {
    const result = validateJudgeOutputDetailed({ route: "delegate", confidence: 0.7 });

    expect(result.valid).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toEqual([
      "missing_scope",
      "missing_tool_need_hint",
      "missing_duration_hint",
    ]);
  });

  it("accepts full structured delegate output as authoritative", () => {
    const result = validateJudgeOutputDetailed({
      route: "delegate",
      confidence: 0.7,
      scope: "local",
      tool_need_hint: "required",
      duration_hint: "medium",
    });

    expect(result).toEqual({
      valid: true,
      degraded: false,
      degradedReasons: [],
    });
  });

  it("accepts reply output without delegate-only structure", () => {
    const result = validateJudgeOutputDetailed({ route: "reply", confidence: 0.8 });

    expect(result).toEqual({
      valid: true,
      degraded: false,
      degradedReasons: [],
    });
  });
});
