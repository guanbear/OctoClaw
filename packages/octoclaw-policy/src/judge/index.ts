import type { BackendType, WorkspaceMode } from "@octoclaw/contracts/schemas";
import { evaluateAdmission, type AdmissionDecision } from "../admission/index.js";
import { decidePolicyCaps, type CapsDecision } from "../caps/index.js";
import { buildCompoundPolicyPlaceholder, type CompoundPolicyPlaceholder } from "../compound/index.js";
import { decideBackend, decideExecutionProfile, decideModelProfile, type ExecutionProfileTarget, type ModelProfile } from "../model/index.js";
import { buildIntentPacket, type IntentClass, type IntentHints, type IntentPacket } from "../intent/index.js";
import { decideRole, type PolicyRole } from "../roles/index.js";
import { decideRoute, type LiveRoute } from "../route/index.js";

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

export interface JudgeFastInput extends PolicyJudgeInput {
  intent?: IntentHints;
}

export type CoordinationMode = "solo_worker" | "advisor_assisted" | "threaded_subagents" | "compound";

export function decideCoordinationMode(route: LiveRoute, _role: PolicyRole): CoordinationMode | undefined {
  if (route === "delegate.single") return "solo_worker";
  return undefined;
}

export interface PolicyDecision {
  route: LiveRoute;
  role: PolicyRole;
  coordinationMode?: CoordinationMode;
  backend: BackendType;
  executionProfile: ExecutionProfileTarget;
  workspaceMode: WorkspaceMode;
  modelProfile: ModelProfile;
  caps: CapsDecision;
  admission: AdmissionDecision;
  decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"];
}

export interface JudgeFastOutput {
  intent: IntentPacket;
  decision: PolicyDecision;
  compound: CompoundPolicyPlaceholder;
}

export function judgePolicy(input: PolicyJudgeInput): PolicyDecision {
  const route = decideRoute({
    requestedRoute: input.requestedRoute,
    hardBoundaryControl: input.hardBoundaryControl,
    requiresObservation: input.requiresObservation,
    requiresDelegation: input.requiresDelegation,
    capabilitySatisfied: input.capabilitySatisfied,
    workspaceMode: input.workspaceMode,
  });
  const role = decideRole(route.route, input.workType);
  const coordinationMode = decideCoordinationMode(route.route, role.role);
  const backend = decideBackend(role.role);
  const executionProfile = decideExecutionProfile(role.role);
  const model = decideModelProfile(role.role, route.workspaceMode);
  const caps = decidePolicyCaps({
    role: role.role,
    queueBudget: input.queueBudget,
  });
  const admission = evaluateAdmission({
    route: route.route,
    queueBudget: caps.queueBudget,
    inflightCount: input.inflightCount,
    capabilitySatisfied: input.capabilitySatisfied,
    workspaceMode: route.workspaceMode,
    writeConflict: input.writeConflict,
    maxWorkers: caps.maxWorkers,
    latencyTarget: caps.latencyTarget,
  });

  return {
    route: route.route,
    role: role.role,
    coordinationMode,
    backend: backend.backend,
    executionProfile: executionProfile.executionProfile,
    workspaceMode: model.workspaceMode,
    modelProfile: model.modelProfile,
    caps,
    admission,
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

export function judgeFast(input: JudgeFastInput): JudgeFastOutput {
  const intent = buildIntentPacket(input.intent);
  return {
    intent,
    decision: judgePolicy(input),
    compound: buildCompoundPolicyPlaceholder(),
  };
}

export type { IntentClass };
