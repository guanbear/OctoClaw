import type { PolicyRole } from "@octoclaw/policy/roles";
import { resolveDelegationProfile } from "../profiles/index.js";

export interface WorkerBriefTemplate {
  goal: string;
  constraints: string[];
  expectedOutput: string;
  relevantArtifactRefs: string[];
  runtimeLimits: {
    maxDurationMs?: number;
    maxTokens?: number;
  };
  deliveryContract: string;
  role?: PolicyRole;
  doneDefinition: string[];
  modelProfile?: string;
  allowedTools: string[];
  outputContract: string;
  objective?: string;
}

export function buildWorkerBrief(role: PolicyRole, goal: string): WorkerBriefTemplate {
  const profile = resolveDelegationProfile(role);
  return {
    goal,
    constraints: [
      "Respect runtime-managed claim ownership and keep the assigned claim token authoritative for the delegated task.",
      "Preserve the delegated delivery receipt chain so downstream execution stays auditable.",
      "Do not exceed declared workspace scope.",
    ],
    expectedOutput: profile.outputContract,
    relevantArtifactRefs: [],
    runtimeLimits: {},
    deliveryContract: profile.outputContract,
    role,
    doneDefinition: [
      "Return a concise worker result.",
      "Report completion with the delegated delivery receipt and ownership context intact.",
      "Attach artifacts instead of mutating undeclared workspace paths.",
    ],
    modelProfile: profile.modelProfile,
    allowedTools: profile.allowedTools,
    outputContract: profile.outputContract,
    objective: goal,
  };
}
