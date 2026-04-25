import type { BackendType, ConcreteModelId, ModelProfile, ModelProfileMapping, WorkspaceMode } from "@octoclaw/contracts/schemas";
import type { PolicyRole } from "../roles/index.js";

export type { ModelProfile } from "@octoclaw/contracts/schemas";

export type ExecutionProfileTarget = "main" | "observer" | "worker";

export interface BackendDecision {
  backend: BackendType;
  backendReason: string;
}

export interface ExecutionProfileDecision {
  executionProfile: ExecutionProfileTarget;
  executionProfileReason: string;
}

export interface ModelSelection {
  workspaceMode: WorkspaceMode;
  modelProfile: ModelProfile;
  modelReason: string;
}

export const V1_MODEL_PROFILE_MAP: Record<ModelProfile, ConcreteModelId> = {
  judge_fast: "minimax-portal/MiniMax-M2.7",
  observer_probe: "minimax-portal/MiniMax-M2.7",
  direct_main: "zhipu/GLM-5.1",
  worker_default: "zhipu/GLM-5.1",
  worker_research: "zhipu/GLM-5.1",
  worker_code_normal: "zhipu/GLM-5.1",
  worker_code_deep: "omniroute/cx/gpt-5.4",
  worker_review: "omniroute/cx/gpt-5.4",
  worker_deep: "omniroute/cx/gpt-5.4",
};

export const V1_MODEL_PROFILE_MAPPINGS: ModelProfileMapping[] = Object.entries(V1_MODEL_PROFILE_MAP).map(
  ([profile, modelId]) => ({ profile: profile as ModelProfile, modelId }),
);

export const BASELINE_MODEL_PROFILE_MAP: Record<ModelProfile, ConcreteModelId> = { ...V1_MODEL_PROFILE_MAP };

export interface ShadowModelRecommendationInput {
  liveProfile: ModelProfile;
  lane: "reply" | "delegate" | "flow";
  qualityRisk?: "low" | "medium" | "high";
}

export interface ShadowModelRecommendation {
  mode: "shadow";
  liveProfile: ModelProfile;
  liveModelId: ConcreteModelId;
  recommendedProfile: ModelProfile;
  recommendedModelId: ConcreteModelId;
  promotionAllowed: false;
  rollbackTarget: ModelProfile;
  reason: string;
}

export interface ShadowRecommendationComparison {
  recommendation: ShadowModelRecommendation;
  actualProfile: ModelProfile;
  actualModelId: ConcreteModelId;
  matchedRecommendation: boolean;
  livePathChanged: false;
}

export interface ShadowPromotionDecision {
  promotionAllowed: boolean;
  rollbackTarget: ModelProfile;
  reason: string;
}

export function resolveModelId(profile: ModelProfile): ConcreteModelId {
  return V1_MODEL_PROFILE_MAP[profile];
}

export function recommendModelProfileShadow(input: ShadowModelRecommendationInput): ShadowModelRecommendation {
  const recommendedProfile: ModelProfile = input.qualityRisk === "low" && input.lane === "reply"
    ? "judge_fast"
    : input.liveProfile;
  return {
    mode: "shadow",
    liveProfile: input.liveProfile,
    liveModelId: resolveModelId(input.liveProfile),
    recommendedProfile,
    recommendedModelId: resolveModelId(recommendedProfile),
    promotionAllowed: false,
    rollbackTarget: input.liveProfile,
    reason: recommendedProfile === input.liveProfile
      ? "shadow_keeps_live_profile_until_gate_pass"
      : "shadow_recommends_lower_cost_reply_profile_without_live_change",
  };
}

export function evaluateShadowPromotion(input: {
  recommendation: ShadowModelRecommendation;
  gateOverall: "pass" | "fail" | "unknown";
}): ShadowPromotionDecision {
  if (input.gateOverall !== "pass") {
    return {
      promotionAllowed: false,
      rollbackTarget: input.recommendation.rollbackTarget,
      reason: `gate_${input.gateOverall}_blocks_promotion`,
    };
  }
  return {
    promotionAllowed: true,
    rollbackTarget: input.recommendation.rollbackTarget,
    reason: "gate_pass_allows_manual_promotion",
  };
}

export function compareShadowRecommendationToActual(input: {
  recommendation: ShadowModelRecommendation;
  actualProfile: ModelProfile;
}): ShadowRecommendationComparison {
  return {
    recommendation: input.recommendation,
    actualProfile: input.actualProfile,
    actualModelId: resolveModelId(input.actualProfile),
    matchedRecommendation: input.actualProfile === input.recommendation.recommendedProfile,
    livePathChanged: false,
  };
}

export function decideExecutionProfile(role: PolicyRole): ExecutionProfileDecision {
  if (role === "main_reply") {
    return { executionProfile: "main", executionProfileReason: "main_reply_stays_on_main_execution_profile" };
  }
  if (role === "observer_probe") {
    return { executionProfile: "observer", executionProfileReason: "observer_probe_uses_observer_execution_profile" };
  }
  return { executionProfile: "worker", executionProfileReason: "delegated_roles_use_worker_execution_profile" };
}

export function decideBackend(_role: PolicyRole): BackendDecision {
  return {
    backend: "openclaw-native",
    backendReason: "phase1_routes_all_use_openclaw_native_backend",
  };
}

export function decideModelProfile(role: PolicyRole, workspaceMode: WorkspaceMode): ModelSelection {
  if (role === "observer_probe") {
    return { workspaceMode, modelProfile: "observer_probe", modelReason: "observe_role_maps_to_observer_probe_profile" };
  }
  if (role === "worker_code") {
    return {
      workspaceMode,
      modelProfile: workspaceMode === "shared_workspace" ? "worker_code_deep" : "worker_code_normal",
      modelReason: workspaceMode === "shared_workspace"
        ? "worker_code_shared_workspace_maps_to_worker_code_deep"
        : "worker_code_non_shared_workspace_maps_to_worker_code_normal",
    };
  }
  if (role === "worker_review") {
    return { workspaceMode, modelProfile: "worker_review", modelReason: "worker_review_maps_to_worker_review_profile" };
  }
  if (role === "worker_research") {
    return { workspaceMode, modelProfile: "worker_research", modelReason: "worker_research_maps_to_worker_research_profile" };
  }
  return { workspaceMode, modelProfile: "direct_main", modelReason: "main_reply_uses_direct_main_profile" };
}
