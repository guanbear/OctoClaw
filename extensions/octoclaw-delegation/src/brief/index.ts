import type { PolicyRole } from "../../../../packages/octoclaw-policy/src/roles";

export interface WorkerBriefTemplate {
  role: PolicyRole;
  objective: string;
  constraints: string[];
  doneDefinition: string[];
}

export function buildWorkerBrief(role: PolicyRole, objective: string): WorkerBriefTemplate {
  return {
    role,
    objective,
    constraints: [
      "Respect runtime-managed claim ownership and delivery contracts.",
      "Do not exceed declared workspace scope.",
    ],
    doneDefinition: [
      "Return a concise worker result.",
      "Attach artifacts instead of mutating undeclared workspace paths.",
    ],
  };
}
