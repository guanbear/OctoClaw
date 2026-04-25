import type {
  DelegateContract,
  NativeBindingRef,
  WorkContract,
  WorkContractStatus,
  WorkContractTelemetry,
} from "@octoclaw/contracts/work-contract";
import { updateWorkContract } from "./store.js";
import { markChildSessionPreferred } from "./continuity.js";

export interface MaterializationSuccessInput {
  workContractId: string;
  ledgerPath?: string;
  nativeBinding: NativeBindingRef;
  delegateTaskId: string;
  attemptId: string;
  nativeTaskId?: string;
  nativeFlowId?: string;
  childSessionKey?: string;
  substrateState?: string;
  spawnExecuted: boolean;
  childSessionId?: string;
  runId?: string;
  providerSessionBinding?: { provider: string; sessionId?: string; runtimeSessionName?: string; sessionFile?: string };
  expectsCompletionMessage?: boolean;
  directThreadDelivery?: boolean;
}

export interface MaterializationFailureInput {
  workContractId: string;
  ledgerPath?: string;
  errorMessage: string;
  nativeBinding?: NativeBindingRef;
}

type SubstrateStatus = "queued" | "planned" | "running" | "completed" | "succeeded" | "failed" | "blocked" | "cancelled" | "lost";

function mapSubstrateToContractStatus(substrate: string | undefined): WorkContractStatus {
  switch (substrate as SubstrateStatus) {
    case "queued":
    case "planned":
      return "planned";
    case "running":
      return "running";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      return "queued";
  }
}

function ensureDelegate(contract: WorkContract, overrides: Partial<DelegateContract> = {}): DelegateContract {
  if (contract.delegate) {
    return { ...contract.delegate, ...overrides };
  }
  return {
    delegateTaskId: overrides.delegateTaskId ?? "",
    currentAttemptId: overrides.currentAttemptId ?? null,
    role: contract.decision.delegateRole ?? "default",
    coordinationMode: "solo_worker",
    acceptanceCriteria: [],
    scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
    modelProfile: "",
    nativeBinding: overrides.nativeBinding ?? null,
    childSessions: [],
    artifactRefs: [],
    nextAction: overrides.nextAction ?? "dispatch",
    ...overrides,
  };
}

export function materializeWorkContractSuccess(input: MaterializationSuccessInput): WorkContract | null {
  const mappedStatus = mapSubstrateToContractStatus(input.substrateState);

  const result = updateWorkContract(
    input.workContractId,
    (contract) => {
      const now = new Date().toISOString();
      const updatedDelegate = ensureDelegate(contract, {
        delegateTaskId: input.delegateTaskId,
        currentAttemptId: input.attemptId,
        nativeBinding: input.nativeBinding,
      });

      const telemetry: WorkContractTelemetry = {
        ...contract.telemetry,
        dispatchExecuted: true,
        spawnExecuted: input.spawnExecuted || false,
        nativeTaskId: input.nativeTaskId || input.nativeBinding.nativeTaskId || input.nativeBinding.taskId,
        nativeFlowId: input.nativeFlowId || input.nativeBinding.nativeFlowId || input.nativeBinding.flowId,
        nativeFlowRevision: input.nativeBinding.revision,
        nativeFlowExpectedRevision: input.nativeBinding.expectedRevision,
        nativeFlowMutation: input.nativeBinding.lastMutation,
        nativeFlowMutationApplied: input.nativeBinding.lastMutationApplied,
        nativeFlowMutationError: input.nativeBinding.lastMutationError,
        resultMaterialized: Boolean(input.nativeTaskId || input.nativeBinding.nativeTaskId || input.nativeBinding.taskId),
        deliveryStatus: input.substrateState ?? "none",
        childSessionKey: input.childSessionKey ?? input.nativeBinding.childSessionKey,
      };

      const mainContext = {
        ...contract.mainContext,
        statusLine: `${mappedStatus}: ${input.substrateState ?? "dispatched"}`,
        visibleIds: {
          ...contract.mainContext.visibleIds,
          delegateTaskId: input.delegateTaskId,
          attemptId: input.attemptId,
          nativeTaskId: input.nativeTaskId || input.nativeBinding.nativeTaskId || input.nativeBinding.taskId,
          nativeFlowId: input.nativeFlowId || input.nativeBinding.nativeFlowId || input.nativeBinding.flowId,
          childSessionKey: input.childSessionKey ?? input.nativeBinding.childSessionKey,
        },
        nextAction: mappedStatus === "running" ? "wait" : mappedStatus === "completed" ? "deliver" : "dispatch",
      };

      const continuity = {
        ...contract.continuity,
        delegateTaskId: input.delegateTaskId,
        preferredChildSessionKey: input.childSessionKey ?? input.nativeBinding.childSessionKey ?? contract.continuity.preferredChildSessionKey,
      };

      return {
        ...contract,
        status: mappedStatus,
        delegate: updatedDelegate,
        telemetry,
        mainContext,
        continuity,
        updatedAt: now,
      };
    },
    input.ledgerPath,
  );

  if (result && input.childSessionKey) {
    const marked = markChildSessionPreferred({
      workContractId: input.workContractId,
      ledgerPath: input.ledgerPath,
      childSessionKey: input.childSessionKey,
      delegateTaskId: input.delegateTaskId,
      attemptId: input.attemptId,
      agentRole: result.delegate?.role ?? "default",
      modelProfile: result.delegate?.modelProfile ?? "",
      parentSessionKey: result.sessionKey,
      threadBindingKey: result.continuity.threadBindingKey,
      scopeFingerprint: result.delegate?.scope.scopeFingerprint ?? "",
      childSessionId: input.childSessionId,
      runId: input.runId,
      providerSessionBinding: input.providerSessionBinding,
      expectsCompletionMessage: input.expectsCompletionMessage,
      directThreadDelivery: input.directThreadDelivery,
    });
    return marked ?? result;
  }

  return result;
}

export function materializeWorkContractFailure(input: MaterializationFailureInput): WorkContract | null {
  return updateWorkContract(
    input.workContractId,
    (contract) => {
      const now = new Date().toISOString();
      const telemetry: WorkContractTelemetry = {
        ...contract.telemetry,
        dispatchExecuted: false,
        resultMaterialized: false,
        deliveryStatus: "failed",
        nativeFlowMutationError: input.errorMessage,
      };

      const nativeBinding: NativeBindingRef | null = input.nativeBinding
        ? {
            ...input.nativeBinding,
            lastMutation: input.nativeBinding.lastMutation,
            lastMutationApplied: false,
          }
        : (contract.delegate?.nativeBinding ?? null);

      const updatedDelegate = ensureDelegate(contract, {
        nativeBinding,
        nextAction: "retry" as const,
        blocker: input.errorMessage,
      });

      const mainContext = {
        ...contract.mainContext,
        statusLine: `failed: ${input.errorMessage.slice(0, 100)}`,
        nextAction: "retry",
      };

      return {
        ...contract,
        status: "failed",
        delegate: updatedDelegate,
        telemetry,
        mainContext,
        updatedAt: now,
      };
    },
    input.ledgerPath,
  );
}
