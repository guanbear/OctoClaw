import { describe, expect, it } from "vitest";
import { classifyBudgetedMainTool } from "./budgeted-main.js";

describe("classifyBudgetedMainTool", () => {
  it("treats structured OpenClaw gateway status with safe output truncation as read-only", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "openclaw gateway status 2>&1 | head -30",
      timeout: 15,
    });

    expect(classification.readOnly).toBe(true);
    expect(classification.escalationReason).toBe("");
    expect(classification.multiStepToolDetected).toBe(false);
    expect(classification.longToolDetected).toBe(false);
    expect(classification.unknownToolRiskDetected).toBe(false);
  });

  it("does not mark OpenClaw mutating subcommands read-only just because the noun is known", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "openclaw models fallbacks add zhipu/GLM-5.1",
    });

    expect(classification.readOnly).toBe(false);
    expect(classification.escalationReason).not.toBe("");
  });
});
