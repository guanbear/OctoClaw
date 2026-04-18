import { describe, expect, it } from "vitest";
import { buildWorkerBrief } from "./index.js";

describe("buildWorkerBrief", () => {
  const objective = JSON.stringify({
    goal: "Implement the delegated change safely",
    constraints: ["stay within declared scope", "preserve receipts"],
    expected_output: "Return a concise worker_result payload",
    relevant_artifact_refs: ["artifacts/spec.md", "artifacts/plan.json"],
  });

  it("produces a code profile brief", () => {
    const brief = buildWorkerBrief("worker_code", objective);

    expect(brief.role).toBe("worker_code");
    expect(brief.modelProfile).toBe("code");
    expect(brief.allowedTools).toEqual(["read", "edit", "write", "bash", "lsp"]);
    expect(brief.outputContract).toBe("worker_result");
  });

  it("produces a research profile brief", () => {
    const brief = buildWorkerBrief("worker_research", objective);

    expect(brief.role).toBe("worker_research");
    expect(brief.modelProfile).toBe("research");
    expect(brief.allowedTools).toEqual(["search", "read", "webfetch"]);
    expect(brief.outputContract).toBe("worker_result");
  });

  it("produces a review profile brief", () => {
    const brief = buildWorkerBrief("worker_review", objective);

    expect(brief.role).toBe("worker_review");
    expect(brief.modelProfile).toBe("review");
    expect(brief.allowedTools).toEqual(["read", "grep", "lsp"]);
    expect(brief.outputContract).toBe("review_result");
  });

  it("includes contract fields and keeps context minimal", () => {
    const brief = buildWorkerBrief("worker_code", objective);

    expect(brief.constraints).toHaveLength(3);
    expect(brief.doneDefinition).toHaveLength(3);
    expect(brief.allowedTools.length).toBeGreaterThan(0);
    expect(brief.outputContract).toBe("worker_result");
    expect(brief.objective).toContain("goal");
    expect(brief.objective).toContain("constraints");
    expect(brief.objective).toContain("expected_output");
    expect(brief.objective).toContain("relevant_artifact_refs");
    expect("transcript" in brief).toBe(false);
    expect(Object.keys(brief)).not.toContain("transcript");
  });
});
