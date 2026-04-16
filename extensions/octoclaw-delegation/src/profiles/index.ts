import type { PolicyRole } from "../../../../packages/octoclaw-policy/src/roles/index.ts";

export interface DelegationProfile {
  id: PolicyRole;
  label: string;
  defaultObjective: string;
}

export const worker_research: DelegationProfile = {
  id: "worker_research",
  label: "Research worker",
  defaultObjective: "Gather evidence, summarize options, and avoid write actions beyond declared scope.",
};

export const worker_code: DelegationProfile = {
  id: "worker_code",
  label: "Code worker",
  defaultObjective: "Implement targeted changes within declared write scope and report verification results.",
};

export const worker_review: DelegationProfile = {
  id: "worker_review",
  label: "Review worker",
  defaultObjective: "Inspect artifacts, identify risks, and keep the workspace read-only unless explicitly granted write scope.",
};

export const DELEGATION_PROFILES = {
  worker_research,
  worker_code,
  worker_review,
} as const;
