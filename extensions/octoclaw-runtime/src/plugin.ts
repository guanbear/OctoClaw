import type { RuntimeWorkflowState } from "@octoclaw/runtime-core/workflow";
import { judgePolicy, type PolicyDecision, type PolicyJudgeInput } from "@octoclaw/policy/judge";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type { RuntimeProjectionPayload, RuntimeNativeTruthPayload } from "./adapter/runtime-taskflow.js";
import {
  createRuntimeTaskflowAdapter,
  type RuntimeTaskflowAdapter,
  type RuntimeTaskflowManagedRecord,
  type RuntimeTaskflowTaskRecord,
} from "./adapter/runtime-taskflow.js";
import { createRuntimeWebhookSurface, type RuntimeWebhookSurface } from "./adapter/webhook-surface.js";
import { createNativeTruthArtifactKinds } from "@octoclaw/contracts/artifacts";
import type { NativeHelperInvoker } from "./adapter/native-helper.js";

export interface OctoClawRuntimePluginOptions {
  helperInvoker?: NativeHelperInvoker;
}

export interface OctoClawRuntimePlugin {
  name: "octoclaw-runtime-ts";
  createAdapter: () => RuntimeTaskflowAdapter;
  createWebhookSurface: () => RuntimeWebhookSurface;
  readBinding: (state: RuntimeWorkflowState) => {
    taskId: string;
    flowId: string;
    status: string;
    runtime: "openclaw-native";
    syncMode: "managed" | "mirrored";
    substrateState: string;
    substrateRevision: number;
    truth: RuntimeTaskflowManagedRecord["truth"];
    projection: RuntimeTaskflowTaskRecord["projection"];
  };
  bindWorkflow: (state: RuntimeWorkflowState) => {
    taskId: string;
    flowId: string;
    status: string;
    runtime: "openclaw-native";
    syncMode: "managed" | "mirrored";
    substrateState: string;
    substrateRevision: number;
    truth: RuntimeTaskflowManagedRecord["truth"];
    projection: RuntimeTaskflowTaskRecord["projection"];
  };
  judgeRoute: (input: PolicyJudgeInput) => PolicyDecision;
}

export { createNativeTruthArtifactKinds };

export function resolveRuntimePolicyDecision(input: PolicyJudgeInput): PolicyDecision {
  return judgePolicy(input);
}

export function createOctoClawRuntimePlugin(options: OctoClawRuntimePluginOptions = {}): OctoClawRuntimePlugin {
  const createAdapter = (): RuntimeTaskflowAdapter => createRuntimeTaskflowAdapter(options.helperInvoker);
  const createWebhook = (): RuntimeWebhookSurface => createRuntimeWebhookSurface({ helperInvoker: options.helperInvoker, adapter: createAdapter() });
  const readBinding = (state: RuntimeWorkflowState) => {
    const identity = state.identity ?? {
      requestId: (state as unknown as { requestId?: string }).requestId || "",
      taskId: (state as unknown as { taskId?: string }).taskId || "",
      flowId: (state as unknown as { flowId?: string }).flowId || "",
      route: state.taskMaterialization?.route || "delegate",
      authority: state.taskMaterialization?.authority || "runtime_orchestrator",
      backend: state.taskMaterialization?.backend || "openclaw-native",
      materializationIntent: state.taskMaterialization?.materializationIntent || "spawn_single",
    };
    const sessionKey = identity.requestId || identity.taskId || identity.flowId;
    const binding = createAdapter().bindSession(sessionKey);
    const flowState = identity.flowId ? binding.readFlow(identity.flowId) : null;
    const taskState = identity.flowId && identity.taskId ? binding.readTask(identity.flowId, identity.taskId) : null;
    const createdAt = new Date().toISOString();
    const claimOwner = state.claim?.claimOwner || state.taskMaterialization?.claimOwner || "runtime-core";
    const claimToken = state.claim?.claimToken || state.taskMaterialization?.claimToken || "";
    const controllerId = claimOwner || "runtime-core";
    const substrateState = (taskState?.found && taskState.substrateState
      ? taskState.substrateState
      : flowState?.found && flowState.substrateState
        ? flowState.substrateState
        : state.workflowOrchestration) as RuntimeWorkflowState["workflowOrchestration"];
    const substrateRevision = taskState?.found && taskState.substrateRevision !== null
      ? taskState.substrateRevision
      : flowState?.found && flowState.substrateRevision !== null
        ? flowState.substrateRevision
        : 0;
    const taskId = taskState?.found && taskState.taskId
      ? taskState.taskId
      : identity.taskId || "";
    const flowId = flowState?.found && flowState.flowId
      ? flowState.flowId
      : taskState?.found && taskState.flowId
        ? taskState.flowId
        : identity.flowId || "";
    const syncMode = taskState?.syncMode || "managed";
    const truth: RuntimeNativeTruthPayload & { schemaVersion: string; createdAt: string } = {
      ...buildContractEnvelope("truth", createdAt),
      kind: "truth" as const,
      sessionKey,
      requestId: identity.requestId || sessionKey,
      flowId,
      taskId,
      runtime: "openclaw-native" as const,
      syncMode,
      substrateState,
      substrateRevision,
      managedDisposition: syncMode,
      ownership: {
        claimOwner,
        claimToken,
        controllerId,
      },
      scope: {
        workspaceMode: state.scope.workspaceMode,
        readScopeCount: Array.isArray(state.scope.readScope) ? state.scope.readScope.length : 0,
        writeScopeCount: Array.isArray(state.scope.writeScope) ? state.scope.writeScope.length : 0,
        writeScopeSummary: state.scope.writeScopeSummary || "",
      },
    };
    const projection: RuntimeProjectionPayload & { schemaVersion: string; createdAt: string } = {
      ...buildContractEnvelope("projection", createdAt),
      kind: "projection" as const,
      status: substrateState,
      runtime: "openclaw-native" as const,
      flowId,
      taskId,
      substrateState,
      substrateRevision,
      workspaceMode: state.scope.workspaceMode,
    };
    return {
      taskId,
      flowId,
      status: substrateState,
      runtime: "openclaw-native" as const,
      syncMode,
      substrateState,
      substrateRevision,
      truth,
      projection,
    };
  };
  return {
    name: "octoclaw-runtime-ts",
    createAdapter,
    createWebhookSurface: createWebhook,
    judgeRoute: (input) => resolveRuntimePolicyDecision(input),
    readBinding,
    bindWorkflow: (state) => {
        const identity = state.identity ?? {
          requestId: (state as unknown as { requestId?: string }).requestId || "",
          taskId: (state as unknown as { taskId?: string }).taskId || "",
        };
        const binding = createAdapter().bindSession(identity.requestId || identity.taskId);
        binding.createManaged(state);
        const taskTruth = binding.runTask(state);
        return {
        taskId: taskTruth.taskId,
        flowId: taskTruth.flowId,
        status: taskTruth.substrateState,
        runtime: "openclaw-native",
        syncMode: taskTruth.syncMode,
        substrateState: taskTruth.substrateState,
        substrateRevision: taskTruth.substrateRevision,
        truth: taskTruth.truth,
        projection: taskTruth.projection,
      };
    },
  };
}
