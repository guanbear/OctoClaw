import type { HardBoundaryCheckResult } from "@octoclaw/contracts/schemas";

export interface HardBoundaryInput {
  explicitControlAction?: boolean;
  existingTaskBinding?: string;
  isRecoverySession?: boolean;
  permissionBoundaryTriggered?: boolean;
  dangerousWrite?: boolean;
}

export function checkHardBoundary(input: HardBoundaryInput): HardBoundaryCheckResult {
  if (input.explicitControlAction) {
    return { triggered: true, signal: "explicit_control_action", reason: "explicit control action detected" };
  }
  if (input.existingTaskBinding) {
    return {
      triggered: true,
      signal: "existing_task_binding",
      routeOverride: "observe",
      reason: `bound to existing task ${input.existingTaskBinding}`,
    };
  }
  if (input.isRecoverySession) {
    return {
      triggered: true,
      signal: "recovery_session",
      routeOverride: "observe",
      reason: "recovery session detected",
    };
  }
  if (input.permissionBoundaryTriggered) {
    return { triggered: true, signal: "permission_boundary", reason: "permission boundary triggered" };
  }
  if (input.dangerousWrite) {
    return { triggered: true, signal: "dangerous_write", reason: "dangerous write operation detected" };
  }
  return { triggered: false, signal: null, reason: "no hard boundary signal" };
}
