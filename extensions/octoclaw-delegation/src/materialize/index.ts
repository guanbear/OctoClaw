import type { ScopeDescriptor, WorkspaceMode } from "../../../../packages/octoclaw-contracts/src/schemas";
import type { PolicyRole } from "../../../../packages/octoclaw-policy/src/roles";
import { buildWorkerBrief } from "../brief";

export interface DelegatedMaterialization {
  role: PolicyRole;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: WorkspaceMode;
  writeScopeSummary: string;
  brief: ReturnType<typeof buildWorkerBrief>;
}

export function materializeDelegatedWork(input: {
  role: PolicyRole;
  objective: string;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: WorkspaceMode;
}): DelegatedMaterialization {
  return {
    role: input.role,
    readScope: input.readScope,
    writeScope: input.writeScope,
    workspaceMode: input.workspaceMode,
    writeScopeSummary: input.writeScope.map((scope) => scope.resource).join(", ") || "read_only",
    brief: buildWorkerBrief(input.role, input.objective),
  };
}
