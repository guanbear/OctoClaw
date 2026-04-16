import type { WorkspaceMode } from "../../../octoclaw-contracts/src/schemas";
import type { PolicyRole } from "../roles";

export type BackendTarget = "main" | "observer" | "worker";
export type ModelProfile = "balanced" | "research" | "code" | "review" | "observe";

export interface BackendDecision {
  backend: BackendTarget;
  backendReason: string;
}

export interface ModelSelection {
  workspaceMode: WorkspaceMode;
  modelProfile: ModelProfile;
  modelReason: string;
}

export function decideBackend(role: PolicyRole): BackendDecision {
  if (role === "main_reply") {
    return { backend: "main", backendReason: "main_reply_stays_on_main_backend" };
  }
  if (role === "observer_probe") {
    return { backend: "observer", backendReason: "observer_probe_uses_observer_backend" };
  }
  return { backend: "worker", backendReason: "delegated_roles_use_worker_backend" };
}

export function decideModelProfile(role: PolicyRole, workspaceMode: WorkspaceMode): ModelSelection {
  if (role === "observer_probe") {
    return { workspaceMode, modelProfile: "observe", modelReason: "observe_role_maps_to_observe_profile" };
  }
  if (role === "worker_code") {
    return { workspaceMode, modelProfile: "code", modelReason: "worker_code_maps_to_code_profile" };
  }
  if (role === "worker_review") {
    return { workspaceMode, modelProfile: "review", modelReason: "worker_review_maps_to_review_profile" };
  }
  if (role === "worker_research") {
    return { workspaceMode, modelProfile: "research", modelReason: "worker_research_maps_to_research_profile" };
  }
  return { workspaceMode, modelProfile: "balanced", modelReason: "main_reply_uses_balanced_profile" };
}
