import type { WorkspaceMode } from "@octoclaw/contracts/schemas";
import type { LatencyTarget } from "../caps/index.js";
import type { LiveRoute } from "../route/index.js";

export interface AdmissionInput {
  route: LiveRoute;
  queueBudget: number;
  inflightCount: number;
  capabilitySatisfied: boolean;
  workspaceMode: WorkspaceMode;
  writeConflict: boolean;
  maxWorkers?: number;
  latencyTarget?: LatencyTarget;
}

export interface AdmissionDecision {
  admission: "allow" | "defer" | "reject";
  queueBudget: number;
  maxWorkers?: number;
  latencyTarget?: LatencyTarget;
  reason: string;
}

export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  if (!input.capabilitySatisfied) {
    return {
      admission: "reject",
      queueBudget: input.queueBudget,
      maxWorkers: input.maxWorkers,
      latencyTarget: input.latencyTarget,
      reason: "capability_guard_failed",
    };
  }

  if (typeof input.maxWorkers === "number" && input.maxWorkers <= 0 && input.route !== "reply") {
    return {
      admission: "reject",
      queueBudget: input.queueBudget,
      maxWorkers: input.maxWorkers,
      latencyTarget: input.latencyTarget,
      reason: "worker_cap_exhausted",
    };
  }

  if (input.route === "delegate.single" && input.inflightCount >= input.queueBudget) {
    return {
      admission: "defer",
      queueBudget: input.queueBudget,
      maxWorkers: input.maxWorkers,
      latencyTarget: input.latencyTarget,
      reason: "queueBudget_exhausted",
    };
  }

  if (input.route === "delegate.single" && input.workspaceMode === "shared_workspace" && input.writeConflict) {
    return {
      admission: "defer",
      queueBudget: input.queueBudget,
      maxWorkers: input.maxWorkers,
      latencyTarget: input.latencyTarget,
      reason: "shared_workspace_write_conflict",
    };
  }

  return {
    admission: "allow",
    queueBudget: input.queueBudget,
    maxWorkers: input.maxWorkers,
    latencyTarget: input.latencyTarget,
    reason: "admission_allowed",
  };
}
