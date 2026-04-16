import type { WorkspaceMode } from "../../../octoclaw-contracts/src/schemas.ts";
import { evaluateAdmission, type AdmissionDecision } from "../admission/index.ts";
import { decideBackend, decideModelProfile, type BackendTarget, type ModelProfile } from "../model/index.ts";
import { decideRole, type PolicyRole } from "../roles/index.ts";
import { decideRoute, type LiveRoute } from "../route/index.ts";

export interface PolicyJudgeInput {
  requestedRoute?: string;
  workType?: "research" | "code" | "review";
  hardBoundaryControl?: boolean;
  requiresObservation?: boolean;
  requiresDelegation?: boolean;
  workspaceMode: WorkspaceMode;
  queueBudget: number;
  inflightCount: number;
  capabilitySatisfied: boolean;
  writeConflict: boolean;
}

export interface PolicyDecision {
  route: LiveRoute;
  role: PolicyRole;
  backend: BackendTarget;
  workspaceMode: WorkspaceMode;
  modelProfile: ModelProfile;
  admission: AdmissionDecision;
  decisionStack: ["route", "role", "backend", "workspace_mode", "model_profile"];
}

export function judgePolicy(input: PolicyJudgeInput): PolicyDecision {
  const route = decideRoute({
    requestedRoute: input.requestedRoute,
    hardBoundaryControl: input.hardBoundaryControl,
    requiresObservation: input.requiresObservation,
    requiresDelegation: input.requiresDelegation,
    workspaceMode: input.workspaceMode,
  });
  const role = decideRole(route.route, input.workType);
  const backend = decideBackend(role.role);
  const model = decideModelProfile(role.role, route.workspaceMode);
  const admission = evaluateAdmission({
    route: route.route,
    queueBudget: input.queueBudget,
    inflightCount: input.inflightCount,
    capabilitySatisfied: input.capabilitySatisfied,
    workspaceMode: route.workspaceMode,
    writeConflict: input.writeConflict,
  });

  return {
    route: route.route,
    role: role.role,
    backend: backend.backend,
    workspaceMode: model.workspaceMode,
    modelProfile: model.modelProfile,
    admission,
    decisionStack: ["route", "role", "backend", "workspace_mode", "model_profile"],
  };
}
