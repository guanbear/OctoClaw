import type {
  MainContextPacket,
  WorkContract,
} from "@octoclaw/contracts/work-contract";
import { sanitizeMainContextInjection } from "../context/context-budget.js";
import { buildContinuationHandle } from "./continuity.js";

export function projectMainContextPacket(contract: WorkContract): MainContextPacket {
  const continuationHandle = buildContinuationHandle(contract);
  const preferredMode = contract.continuity.continuationMode;
  const continuationHint = continuationHandle && preferredMode === "resume_preferred"
    ? { handle: continuationHandle, preferredMode, text: "resume_dont_restart" as const }
    : contract.mainContext.continuationHint;

  const packet: MainContextPacket = {
    summary: contract.mainContext.summary,
    statusLine: contract.mainContext.statusLine,
    visibleIds: {
      workContractId: contract.workContractId,
      delegateTaskId: contract.delegate?.delegateTaskId,
      attemptId: contract.delegate?.currentAttemptId ?? undefined,
      nativeFlowId: contract.delegate?.nativeBinding?.flowId ?? contract.nativeSpawnRefs?.openclawFlowId,
      nativeTaskId: contract.delegate?.nativeBinding?.nativeTaskId,
      childSessionKey: contract.delegate?.nativeBinding?.childSessionKey
        ?? contract.nativeSpawnRefs?.childSessionKey
        ?? contract.continuity.preferredChildSessionKey,
      childSessionId: contract.continuity.preferredChildSessionId
        ?? contract.delegate?.nativeBinding?.runId
        ?? contract.nativeSpawnRefs?.openclawRunId,
      openclawRunId: contract.nativeSpawnRefs?.openclawRunId,
      spawnIntentId: contract.nativeSpawnRefs?.spawnIntentId,
      spawnBackend: contract.nativeSpawnRefs?.spawnBackend,
      spawnMode: contract.nativeSpawnRefs?.spawnMode,
    },
    continuationHint,
    artifactRefs: contract.mainContext.artifactRefs,
    nextAction: contract.mainContext.nextAction,
    tokenBudget: contract.mainContext.tokenBudget,
    forbiddenContent: contract.mainContext.forbiddenContent,
  };

  return sanitizeMainContextInjection(packet) as MainContextPacket;
}

export interface DelegateStatusProjection {
  workContractId: string;
  delegateTaskId: string | undefined;
  status: string;
  role: string | undefined;
  nextAction: string;
  nativeFlowId: string | undefined;
  openclawRunId: string | undefined;
  spawnIntentId: string | undefined;
  spawnBackend: string | undefined;
  spawnMode: string | undefined;
  artifactRefs: string[];
}

export function projectDelegateStatusPacket(contract: WorkContract): DelegateStatusProjection {
  const packet: DelegateStatusProjection = {
    workContractId: contract.workContractId,
    delegateTaskId: contract.delegate?.delegateTaskId,
    status: contract.status,
    role: contract.delegate?.role,
    nextAction: contract.delegate?.nextAction || contract.mainContext.nextAction,
    nativeFlowId: contract.delegate?.nativeBinding?.flowId ?? contract.nativeSpawnRefs?.openclawFlowId,
    openclawRunId: contract.nativeSpawnRefs?.openclawRunId,
    spawnIntentId: contract.nativeSpawnRefs?.spawnIntentId,
    spawnBackend: contract.nativeSpawnRefs?.spawnBackend,
    spawnMode: contract.nativeSpawnRefs?.spawnMode,
    artifactRefs: (contract.delegate?.artifactRefs || []).map((ref) => ref.artifactId),
  };

  return sanitizeMainContextInjection(packet) as DelegateStatusProjection;
}
