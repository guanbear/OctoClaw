import type { WorkspaceMode } from "../../../octoclaw-contracts/src/schemas";
import type { LiveRoute } from "../route";

export interface AdmissionInput {
  route: LiveRoute;
  queueBudget: number;
  inflightCount: number;
  capabilitySatisfied: boolean;
  workspaceMode: WorkspaceMode;
  writeConflict: boolean;
}

export interface AdmissionDecision {
  admission: "allow" | "defer" | "reject";
  queueBudget: number;
  reason: string;
}

export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  if (!input.capabilitySatisfied) {
    return { admission: "reject", queueBudget: input.queueBudget, reason: "capability_guard_failed" };
  }

  if (input.route === "delegate.single" && input.inflightCount >= input.queueBudget) {
    return { admission: "defer", queueBudget: input.queueBudget, reason: "queueBudget_exhausted" };
  }

  if (input.route === "delegate.single" && input.workspaceMode === "shared_workspace" && input.writeConflict) {
    return { admission: "defer", queueBudget: input.queueBudget, reason: "shared_workspace_write_conflict" };
  }

  return { admission: "allow", queueBudget: input.queueBudget, reason: "admission_allowed" };
}
