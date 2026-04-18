import { describe, expect, it } from "vitest";
import { decideConflictPolicy } from "./index.js";

describe("decideConflictPolicy", () => {
  it("allows parallel work for read_only workspace mode", () => {
    const decision = decideConflictPolicy("read_only", false);

    expect(decision.policy).toBe("allow");
    expect(decision.reason).toContain("read-only workspace");
  });

  it("serializes shared workspace overlapping writes", () => {
    expect(decideConflictPolicy("shared_workspace", true)).toEqual({
      workspaceMode: "shared_workspace",
      hasOverlappingWrites: true,
      policy: "serialize",
      reason: "shared_workspace writes serialize by default to avoid concurrent mutation conflicts",
    });
  });

  it("keeps shared workspace non-overlapping work queue-aware", () => {
    expect(decideConflictPolicy("shared_workspace", false)).toEqual({
      workspaceMode: "shared_workspace",
      hasOverlappingWrites: false,
      policy: "queue",
      reason: "shared_workspace work remains queue-aware even without direct overlap",
    });
  });

  it("allows isolated workspace work with merge-safe note", () => {
    const decision = decideConflictPolicy("isolated_worktree", true);

    expect(decision.policy).toBe("allow");
    expect(decision.reason).toContain("isolated");
  });
});
