import type { PolicyRole } from "@octoclaw/policy/roles";

export type DelegationRole = "worker_research" | "worker_code" | "worker_review";

export interface DelegationProfile {
  id: PolicyRole;
  label: string;
  defaultObjective: string;
  modelProfile: "research" | "code" | "review";
  allowedTools: string[];
  outputContract: "worker_result" | "review_result";
}

export const worker_research: DelegationProfile = {
  id: "worker_research",
  label: "Research worker",
  defaultObjective: "Gather evidence, summarize options, and avoid write actions beyond declared scope.",
  modelProfile: "research",
  allowedTools: ["search", "read", "webfetch"],
  outputContract: "worker_result",
};

export const worker_code: DelegationProfile = {
  id: "worker_code",
  label: "Code worker",
  defaultObjective: "Implement targeted changes within declared write scope and report verification results.",
  modelProfile: "code",
  allowedTools: ["read", "edit", "write", "bash", "lsp"],
  outputContract: "worker_result",
};

export const worker_review: DelegationProfile = {
  id: "worker_review",
  label: "Review worker",
  defaultObjective: "Inspect artifacts, identify risks, and keep the workspace read-only unless explicitly granted write scope.",
  modelProfile: "review",
  allowedTools: ["read", "grep", "lsp"],
  outputContract: "review_result",
};

export const DELEGATION_PROFILES = {
  worker_research,
  worker_code,
  worker_review,
} as const;

function isDelegationRole(role: PolicyRole): role is DelegationRole {
  return role === "worker_research" || role === "worker_code" || role === "worker_review";
}

export function resolveDelegationProfile(role: PolicyRole): DelegationProfile {
  if (!isDelegationRole(role)) {
    throw new Error(`unsupported_delegation_role:${role}`);
  }
  return DELEGATION_PROFILES[role];
}

export function selectDelegationBackend(role: PolicyRole): {
  backend: "openclaw-native" | "clawteam";
  profile: DelegationProfile;
} {
  const profile = resolveDelegationProfile(role);
  return {
    backend: "openclaw-native",
    profile,
  };
}

export * from "./role-registry.js";
export * from "./advisor.js";
