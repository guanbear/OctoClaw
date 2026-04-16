import type { WorkspaceMode } from "../../../../packages/octoclaw-contracts/src/schemas.ts";

export interface ConflictDecision {
  workspaceMode: WorkspaceMode;
  hasOverlappingWrites: boolean;
  policy: "allow" | "serialize" | "queue";
  reason: string;
}

export function decideConflictPolicy(workspaceMode: WorkspaceMode, hasOverlappingWrites: boolean): ConflictDecision {
  if (workspaceMode === "shared_workspace" && hasOverlappingWrites) {
    return {
      workspaceMode: "shared_workspace",
      hasOverlappingWrites: true,
      policy: "serialize",
      reason: "shared_workspace writes serialize by default to avoid concurrent mutation conflicts",
    };
  }

  if (workspaceMode === "shared_workspace") {
    return {
      workspaceMode: "shared_workspace",
      hasOverlappingWrites: false,
      policy: "queue",
      reason: "shared_workspace work remains queue-aware even without direct overlap",
    };
  }

  return {
    workspaceMode,
    hasOverlappingWrites,
    policy: "allow",
    reason: "isolated or read-only workspace can proceed without serialization",
  };
}
