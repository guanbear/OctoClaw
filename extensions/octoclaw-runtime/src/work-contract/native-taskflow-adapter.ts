import type {
  BoundTaskFlowPort,
  FlowMutationInput,
  FlowMutationResult,
  ManagedFlowRecord,
} from "../ports/taskflow-port.js";
import type {
  NativeBindingRef,
  NativeFlowMutation,
  NativeFlowMutationError,
  NativeFlowStatus,
} from "@octoclaw/contracts/work-contract";

export interface NativeTaskflowAdapterResult {
  binding: NativeBindingRef;
  mutationApplied: boolean;
  mutationError?: NativeFlowMutationError;
}

export interface CompactDelegateRef {
  kind: "octoclaw_delegate_ref";
  workContractId: string;
  delegateTaskId: string;
  attemptId: string;
  artifactRefs: string[];
}

export function buildCompactStateJson(ref: CompactDelegateRef): string {
  return JSON.stringify(ref);
}

export async function createManagedWorkFlow(
  port: BoundTaskFlowPort,
  controllerId: string,
  goal: string,
  stateRef: CompactDelegateRef,
): Promise<NativeTaskflowAdapterResult> {
  try {
    const result = await port.createManaged({
      controllerId,
      goal,
      currentStep: "dispatch",
      stateJson: buildCompactStateJson(stateRef),
    });
    const revision = revisionFromRecord(result, 0);
    return successResult(
      buildBinding({
        flowId: result.flowId,
        ownerKey: stateRef.workContractId,
        controllerId,
        revision,
        status: "queued",
        currentStep: "dispatch",
        stateRef: buildCompactStateJson(stateRef),
        lastMutation: "createManaged",
      }),
    );
  } catch (error) {
    return failureResult(
      buildBinding({
        flowId: "",
        ownerKey: stateRef.workContractId,
        controllerId,
        revision: 0,
        status: "lost",
        currentStep: "dispatch",
        stateRef: buildCompactStateJson(stateRef),
        lastMutation: "createManaged",
      }),
      mutationErrorFrom(error) ?? "not_managed",
    );
  }
}

export async function resumeManagedWorkFlow(
  port: BoundTaskFlowPort,
  binding: NativeBindingRef,
  step: string,
): Promise<NativeTaskflowAdapterResult> {
  return mutateBinding(port.setWaiting.bind(port), binding, "resume", {
    flowId: binding.flowId,
    expectedRevision: binding.expectedRevision,
    currentStep: step,
    stateJson: binding.stateRef,
  }, { currentStep: step }, port);
}

export async function setWorkFlowWaiting(
  port: BoundTaskFlowPort,
  binding: NativeBindingRef,
  waitKind: string,
  waitRef?: CompactDelegateRef,
): Promise<NativeTaskflowAdapterResult> {
  const waitJson = waitRef ? buildCompactStateJson(waitRef) : JSON.stringify({ kind: waitKind });
  return mutateBinding(port.setWaiting.bind(port), binding, "setWaiting", {
    flowId: binding.flowId,
    expectedRevision: binding.expectedRevision,
    currentStep: "await_worker",
    waitJson,
  }, { currentStep: "await_worker", waitKind, waitRef: waitJson, status: "waiting" }, port);
}

export async function finishWorkFlow(
  port: BoundTaskFlowPort,
  binding: NativeBindingRef,
  resultRef?: CompactDelegateRef,
): Promise<NativeTaskflowAdapterResult> {
  return mutateBinding(port.finish.bind(port), binding, "finish", {
    flowId: binding.flowId,
    expectedRevision: binding.expectedRevision,
    stateJson: resultRef ? buildCompactStateJson(resultRef) : undefined,
  }, { status: "succeeded", stateRef: resultRef ? buildCompactStateJson(resultRef) : binding.stateRef }, port);
}

export async function failWorkFlow(
  port: BoundTaskFlowPort,
  binding: NativeBindingRef,
  error: string,
): Promise<NativeTaskflowAdapterResult> {
  return mutateBinding(port.fail.bind(port), binding, "fail", {
    flowId: binding.flowId,
    expectedRevision: binding.expectedRevision,
    stateJson: { error },
  }, { status: "failed" }, port);
}

export async function refreshNativeBinding(
  port: BoundTaskFlowPort,
  flowId: string,
): Promise<NativeBindingRef | null> {
  const flow = await port.get(flowId);
  if (!flow) return null;
  const revision = typeof flow.revision === "number" ? flow.revision : 0;
  return buildBinding({
    flowId: flow.flowId,
    ownerKey: flow.flowId,
    controllerId: "octoclaw.delegate",
    revision,
    status: normalizeStatus(flow.status),
  });
}

function buildBinding(input: {
  flowId: string;
  ownerKey: string;
  controllerId: string;
  revision: number;
  status: NativeFlowStatus;
  currentStep?: string;
  waitKind?: string;
  stateRef?: string;
  waitRef?: string;
  lastMutation?: NativeFlowMutation;
}): NativeBindingRef {
  return {
    flowId: input.flowId,
    ownerKey: input.ownerKey,
    controllerId: input.controllerId,
    revision: input.revision,
    expectedRevision: input.revision,
    syncMode: "managed",
    status: input.status,
    currentStep: input.currentStep,
    waitKind: input.waitKind,
    stateRef: input.stateRef,
    waitRef: input.waitRef,
    lastMutation: input.lastMutation,
    lastMutationApplied: input.lastMutation ? true : undefined,
  };
}

async function mutateBinding(
  mutate: (input: FlowMutationInput) => Promise<FlowMutationResult>,
  binding: NativeBindingRef,
  lastMutation: NativeFlowMutation,
  input: FlowMutationInput,
  updates: Partial<Pick<NativeBindingRef, "currentStep" | "waitKind" | "waitRef" | "stateRef" | "status">>,
  port?: BoundTaskFlowPort,
): Promise<NativeTaskflowAdapterResult> {
  try {
    const result = await mutate(input);
    const mutationError = mutationErrorFrom(result);
    if (!result.applied || mutationError) {
      const errorKind = mutationError ?? "revision_conflict";
      // On revision_conflict, attempt to refresh the binding from the current flow
      // so the caller gets an up-to-date projection rather than a stale one.
      if (errorKind === "revision_conflict" && port) {
        const refreshed = await refreshNativeBinding(port, binding.flowId);
        if (refreshed) {
          return {
            binding: {
              ...binding,
              revision: refreshed.revision,
              expectedRevision: refreshed.expectedRevision,
              status: refreshed.status,
              lastMutation,
              lastMutationApplied: false,
              lastMutationError: "revision_conflict",
            },
            mutationApplied: false,
            mutationError: "revision_conflict",
          };
        }
      }
      return failureResult({ ...binding, lastMutation }, errorKind);
    }
    const revision = revisionFromRecord(result, binding.revision);
    return successResult({
      ...binding,
      ...updates,
      revision,
      expectedRevision: revision,
      lastMutation,
      lastMutationApplied: true,
      lastMutationError: undefined,
    });
  } catch (error) {
    return failureResult({ ...binding, lastMutation }, mutationErrorFrom(error) ?? "not_managed");
  }
}

function successResult(binding: NativeBindingRef): NativeTaskflowAdapterResult {
  return { binding, mutationApplied: true };
}

function failureResult(binding: NativeBindingRef, mutationError: NativeFlowMutationError): NativeTaskflowAdapterResult {
  return {
    binding: {
      ...binding,
      lastMutationApplied: false,
      lastMutationError: mutationError,
    },
    mutationApplied: false,
    mutationError,
  };
}

function revisionFromRecord(record: ManagedFlowRecord | FlowMutationResult, fallback: number): number {
  return typeof record.revision === "number" ? record.revision : fallback;
}

function mutationErrorFrom(value: unknown): NativeFlowMutationError | undefined {
  if (isMutationError(value)) return value;
  if (isRecord(value)) {
    if (isMutationError(value.error)) return value.error;
    if (isMutationError(value.lastMutationError)) return value.lastMutationError;
    if (isMutationError(value.mutationError)) return value.mutationError;
    if (isMutationError(value.status) && value.applied === false) return value.status;
    if (isMutationError(value.reason) && value.applied === false) return value.reason;
  }
  return undefined;
}

function normalizeStatus(status: unknown): NativeFlowStatus {
  switch (status) {
    case "queued":
    case "running":
    case "waiting":
    case "blocked":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "lost":
      return status;
    case "completed":
      return "succeeded";
    default:
      return "lost";
  }
}

function isMutationError(value: unknown): value is NativeFlowMutationError {
  return value === "revision_conflict" || value === "not_found" || value === "not_managed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
