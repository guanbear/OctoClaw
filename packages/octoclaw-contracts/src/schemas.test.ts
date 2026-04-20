import { describe, expect, it } from "vitest";
import {
  OCTOCLAW_CONTRACT_SCHEMA_VERSION,
  buildContractEnvelope,
  isWorkspaceMode,
  validateScopeMetadata,
  type ModelProfile,
} from "./schemas.js";

describe("schemas", () => {
  it("accepts valid workspace modes", () => {
    expect(isWorkspaceMode("isolated_worktree")).toBe(true);
    expect(isWorkspaceMode("shared_workspace")).toBe(true);
    expect(isWorkspaceMode("read_only")).toBe(true);
  });

  it("rejects invalid workspace modes", () => {
    expect(isWorkspaceMode("shared")).toBe(false);
    expect(isWorkspaceMode("workspace")).toBe(false);
    expect(isWorkspaceMode("delegate")).toBe(false);
  });

  it("validates scope metadata", () => {
    expect(validateScopeMetadata({
      readScope: [{ resource: "docs", access: "read" }],
      writeScope: [{ resource: "workspace", access: "write" }],
      workspaceMode: "shared_workspace",
    })).toBe(true);

    expect(validateScopeMetadata({
      readScope: [],
      writeScope: [],
      workspaceMode: "invalid_workspace",
    } as unknown as Partial<Parameters<typeof validateScopeMetadata>[0]>)).toBe(false);
  });

  it("builds contract envelope with correct schema version", () => {
    expect(buildContractEnvelope("artifact", "2026-04-18T00:00:00.000Z")).toEqual({
      schemaVersion: OCTOCLAW_CONTRACT_SCHEMA_VERSION,
      kind: "artifact",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });

  it("covers all 9 model profiles", () => {
    const profiles = [
      "judge_fast",
      "observer_probe",
      "direct_main",
      "worker_default",
      "worker_research",
      "worker_code_normal",
      "worker_code_deep",
      "worker_review",
      "worker_deep",
    ] satisfies ModelProfile[];

    expect(profiles).toHaveLength(9);
    expect(new Set(profiles).size).toBe(9);
  });
});
