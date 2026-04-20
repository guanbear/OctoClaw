import type { LiveRoute } from "../route/index.js";

export type PolicyRole = "main_reply" | "observer_probe" | "worker_research" | "worker_code" | "worker_review";

export interface RoleDecision {
  role: PolicyRole;
  roleReason: string;
}

export function decideRole(route: LiveRoute, workType = "research"): RoleDecision {
  if (route === "reply") {
    return { role: "main_reply", roleReason: "reply_route_uses_main_reply" };
  }

  if (workType === "code") {
    return { role: "worker_code", roleReason: "delegate_single_code_role" };
  }

  if (workType === "review") {
    return { role: "worker_review", roleReason: "delegate_single_review_role" };
  }

  return { role: "worker_research", roleReason: "delegate_single_research_role" };
}
