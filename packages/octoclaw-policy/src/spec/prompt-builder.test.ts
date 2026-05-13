import { describe, expect, it } from "vitest";

import { buildLocalJudgeSystemPrompt } from "./prompt-builder.js";

describe("local judge prompt", () => {
  it("keeps SR-P1 routing constraints in a compact prompt", () => {
    const prompt = buildLocalJudgeSystemPrompt();

    expect(prompt.length).toBeLessThan(4200);
    expect(prompt).toContain("Return exactly one JSON object");
    expect(prompt).toContain("Top-level route is only reply or delegate");
    expect(prompt).toContain("Required fields: route, confidence, complexity");
    expect(prompt).toContain("Do not output scenario, complexity_confidence");
    expect(prompt).toContain("role, workType, scope, tool_need_hint, duration_hint");
    expect(prompt).toContain("complexity is simple, normal, complex, or deep");
    expect(prompt).toContain("Runtime maps route and runtime facts");
    expect(prompt).toContain("must_reply");
    expect(prompt).toContain("must_delegate");
    expect(prompt).toContain("budgeted_main_then_delegate");
    expect(prompt).toContain("background/subagent/parallel execution");
    expect(prompt).toContain("code/file mutation");
    expect(prompt).toContain("tests/builds");
    expect(prompt).toContain("review/validation");
    expect(prompt).toContain("Bare opencode/glm/model/tool names");
    expect(prompt).toContain("never spawn only to inspect provenance/status");
    expect(prompt).not.toContain("## JSON schema");
    expect(prompt).not.toContain("90-120");
    expect(prompt).not.toContain(">90");
    expect(prompt).not.toContain("Set 0.7 for routine decisions");
    expect(prompt).not.toContain("Required fields: route, confidence, is_followup");
  });
});
