import type {
  MainContextPacket,
  WorkContract,
} from "@octoclaw/contracts/work-contract";
import { buildContinuationHandle } from "./continuity.js";

export function projectMainContextPacket(contract: WorkContract): MainContextPacket {
  const continuationHandle = buildContinuationHandle(contract);
  const preferredMode = contract.continuity.continuationMode;
  const continuationHint = continuationHandle && preferredMode === "resume_preferred"
    ? { handle: continuationHandle, preferredMode, text: "resume_dont_restart" as const }
    : contract.mainContext.continuationHint;

  return {
    summary: contract.mainContext.summary,
    statusLine: contract.mainContext.statusLine,
    visibleIds: {
      workContractId: contract.workContractId,
      delegateTaskId: contract.delegate?.delegateTaskId,
      attemptId: contract.delegate?.currentAttemptId ?? undefined,
      nativeFlowId: contract.delegate?.nativeBinding?.flowId,
      nativeTaskId: contract.delegate?.nativeBinding?.nativeTaskId,
      childSessionKey: contract.delegate?.nativeBinding?.childSessionKey
        ?? contract.continuity.preferredChildSessionKey,
      childSessionId: contract.continuity.preferredChildSessionId
        ?? contract.delegate?.nativeBinding?.runId,
    },
    continuationHint,
    artifactRefs: contract.mainContext.artifactRefs,
    nextAction: contract.mainContext.nextAction,
    tokenBudget: contract.mainContext.tokenBudget,
    forbiddenContent: contract.mainContext.forbiddenContent,
  };
}

export interface DelegateStatusProjection {
  workContractId: string;
  delegateTaskId: string | undefined;
  status: string;
  role: string | undefined;
  nextAction: string;
  nativeFlowId: string | undefined;
  artifactRefs: string[];
}

export function projectDelegateStatusPacket(contract: WorkContract): DelegateStatusProjection {
  return {
    workContractId: contract.workContractId,
    delegateTaskId: contract.delegate?.delegateTaskId,
    status: contract.status,
    role: contract.delegate?.role,
    nextAction: contract.delegate?.nextAction || contract.mainContext.nextAction,
    nativeFlowId: contract.delegate?.nativeBinding?.flowId,
    artifactRefs: (contract.delegate?.artifactRefs || []).map((ref) => ref.artifactId),
  };
}
