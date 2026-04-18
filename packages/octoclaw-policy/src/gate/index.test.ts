import { describe, expect, it } from "vitest";
import { checkHardBoundary } from "./index.js";

describe("hard boundary gate", () => {
  it("triggers on explicit control action", () => {
    expect(checkHardBoundary({ explicitControlAction: true })).toEqual({
      triggered: true,
      signal: "explicit_control_action",
      reason: "explicit control action detected",
    });
  });

  it("triggers on existing task binding", () => {
    expect(checkHardBoundary({ existingTaskBinding: "task-123" })).toEqual({
      triggered: true,
      signal: "existing_task_binding",
      routeOverride: "observe",
      reason: "bound to existing task task-123",
    });
  });

  it("triggers on recovery session", () => {
    expect(checkHardBoundary({ isRecoverySession: true })).toEqual({
      triggered: true,
      signal: "recovery_session",
      routeOverride: "observe",
      reason: "recovery session detected",
    });
  });

  it("triggers on permission boundary", () => {
    expect(checkHardBoundary({ permissionBoundaryTriggered: true })).toEqual({
      triggered: true,
      signal: "permission_boundary",
      reason: "permission boundary triggered",
    });
  });

  it("triggers on dangerous write", () => {
    expect(checkHardBoundary({ dangerousWrite: true })).toEqual({
      triggered: true,
      signal: "dangerous_write",
      reason: "dangerous write operation detected",
    });
  });

  it("does not trigger without signals", () => {
    expect(checkHardBoundary({})).toEqual({
      triggered: false,
      signal: null,
      reason: "no hard boundary signal",
    });
  });
});
