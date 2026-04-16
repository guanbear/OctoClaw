import type { PolicyRole } from "../../../../packages/octoclaw-policy/src/roles/index.ts";

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
      "Respect runtime-managed claim ownership and keep the assigned claim token authoritative for the delegated task.",
      "Preserve the delegated delivery receipt chain so downstream execution stays auditable.",
      "Do not exceed declared workspace scope.",
    ],
    doneDefinition: [
      "Return a concise worker result.",
      "Report completion with the delegated delivery receipt and ownership context intact.",
      "Attach artifacts instead of mutating undeclared workspace paths.",
    ],
  };
}
