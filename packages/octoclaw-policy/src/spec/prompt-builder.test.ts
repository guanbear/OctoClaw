import { describe, expect, it } from "vitest";

import { buildLocalJudgeSystemPrompt } from "./prompt-builder.js";

describe("local judge prompt", () => {
  it("keeps SR-P1 routing constraints in a compact prompt", () => {
    const prompt = buildLocalJudgeSystemPrompt();

    expect(prompt.length).toBeLessThan(6500);
    expect(prompt).toContain("Return exactly one JSON object");
    expect(prompt).toContain("Top-level route is only reply or delegate");
    expect(prompt).toContain("runtime derives SR-P1 buckets from route plus cost signals");
    expect(prompt).toContain("must_reply");
    expect(prompt).toContain("must_delegate");
    expect(prompt).toContain("budgeted_main_then_delegate");
    expect(prompt).toContain("max_wall_ms=30000");
    expect(prompt).toContain("fresh_live_lookup, route_hint=delegate, or fast_first_response alone");
    expect(prompt).toContain("explicit background/subagent/parallel execution");
    expect(prompt).toContain("后台/子 agent/并行/委派");
    expect(prompt).toContain("code/file mutation");
    expect(prompt).toContain("写代码/改文件/修复");
    expect(prompt).toContain("tests/builds");
    expect(prompt).toContain("跑测试/构建");
    expect(prompt).toContain("review/validation");
    expect(prompt).toContain("Bare opencode/glm/model/tool names");
    expect(prompt).toContain("never spawn only to inspect provenance/status");
    expect(prompt).toContain("decision_bucket as authority");
    expect(prompt).not.toContain("Set 0.7 for routine decisions");
  });
});
