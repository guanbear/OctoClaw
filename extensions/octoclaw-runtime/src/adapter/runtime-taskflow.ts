import type { RuntimeWorkflowState } from "../../../../packages/octoclaw-runtime-core/src/workflow/index.ts";
import {
  buildContractEnvelope,
  type ScopeMetadata,
  type WorkspaceMode,
} from "../../../../packages/octoclaw-contracts/src/schemas.ts";
import { createNativeTruthArtifactKinds } from "../../../../packages/octoclaw-contracts/src/artifacts.ts";
import { invokeNativeHelper, type NativeHelperInvoker } from "./native-helper.ts";

export interface RuntimeNativeTruthPayload {
  kind: "truth";
  sessionKey: string;
  requestId: string;
  flowId: string;
  taskId: string;
  runtime: "openclaw-native";
  syncMode: "managed" | "mirrored";
  substrateState: RuntimeWorkflowState["workflowOrchestration"];
  substrateRevision: number;
  managedDisposition: "managed" | "mirrored";
  ownership: {
    claimOwner: string;
    claimToken: string;
    controllerId: string;
  };
  scope: {
    workspaceMode: WorkspaceMode;
    readScopeCount: number;
    writeScopeCount: number;
    writeScopeSummary: string;
  };
}

export interface RuntimeProjectionPayload {
  kind: "projection";
  status: string;
  runtime: "openclaw-native";
  flowId: string;
  taskId: string;
  substrateState: RuntimeWorkflowState["workflowOrchestration"];
  substrateRevision: number;
  workspaceMode: WorkspaceMode;
}

export interface RuntimeArtifactPayload {
  kind: "artifact";
  taskPacketRef: string;
  schemaPlanes: Array<"truth" | "projection" | "artifact" | "telemetry">;
}

export interface RuntimeTelemetryPayload {
  kind: "telemetry";
  substrateRevision: number;
  syncMode: "managed" | "mirrored";
  claimOwner: string;
}

export interface RuntimeTaskflowManagedRecord {
  flowId: string;
  controllerId: string;
  managed: true;
  runtime: "openclaw-native";
  syncMode: "managed" | "mirrored";
  substrateState: RuntimeWorkflowState["workflowOrchestration"];
  substrateRevision: number;
  managedDisposition: "managed" | "mirrored";
  ownership: {
    claimOwner: string;
    claimToken: string;
    controllerId: string;
  };
  scope: ScopeMetadata;
  truth: RuntimeNativeTruthPayload & { schemaVersion: string; createdAt: string };
  projection: RuntimeProjectionPayload & { schemaVersion: string; createdAt: string };
  artifact: RuntimeArtifactPayload & { schemaVersion: string; createdAt: string };
  telemetry: RuntimeTelemetryPayload & { schemaVersion: string; createdAt: string };
}

export interface RuntimeTaskflowTaskRecord {
  taskId: string;
  flowId: string;
  runtime: "openclaw-native";
  syncMode: "managed" | "mirrored";
  substrateState: RuntimeWorkflowState["workflowOrchestration"];
  substrateRevision: number;
  ownership: {
    claimOwner: string;
    claimToken: string;
    controllerId: string;
  };
  scope: ScopeMetadata;
  truth: RuntimeNativeTruthPayload & { schemaVersion: string; createdAt: string };
  projection: RuntimeProjectionPayload & { schemaVersion: string; createdAt: string };
  artifact: RuntimeArtifactPayload & { schemaVersion: string; createdAt: string };
  telemetry: RuntimeTelemetryPayload & { schemaVersion: string; createdAt: string };
}

export interface RuntimeTaskflowSessionBinding {
  sessionKey: string;
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
  createManaged: (workflow: RuntimeWorkflowState) => RuntimeTaskflowManagedRecord;
  runTask: (workflow: RuntimeWorkflowState) => RuntimeTaskflowTaskRecord;
}

export interface RuntimeTaskflowAdapter {
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
}

function stringifyStateJson(workflow: RuntimeWorkflowState): string {
  return JSON.stringify({
    requestId: workflow.requestId,
    taskId: workflow.taskId,
    flowId: workflow.flowId,
    workflowOrchestration: workflow.workflowOrchestration,
    reconcileOrRecovery: workflow.reconcileOrRecovery,
  });
}

function buildGoal(workflow: RuntimeWorkflowState): string {
  return String(
    workflow.taskMaterialization?.taskPacketRef
      || workflow.requestId
      || workflow.taskId
      || workflow.flowId,
  ).trim();
}

function normalizeScope(scope: ScopeMetadata): ScopeMetadata {
  return {
    readScope: Array.isArray(scope?.readScope) ? scope.readScope : [],
    writeScope: Array.isArray(scope?.writeScope) ? scope.writeScope : [],
    workspaceMode: scope?.workspaceMode || "isolated_workspace",
    writeScopeSummary: scope?.writeScopeSummary,
  };
}

function deriveTruthShape(
  sessionKey: string,
  workflow: RuntimeWorkflowState,
  native: {
    flowId: string;
    taskId: string;
    syncMode: "managed" | "mirrored";
    substrateState: RuntimeWorkflowState["workflowOrchestration"];
    substrateRevision: number;
    managedDisposition: "managed" | "mirrored";
  },
) {
  const scope = normalizeScope(workflow.scope);
  const claimOwner = workflow.claim?.claimOwner || workflow.taskMaterialization?.claimOwner || "runtime-core";
  const claimToken = workflow.claim?.claimToken || workflow.taskMaterialization?.claimToken || "";
  const controllerId = claimOwner || "runtime-core";
  const { flowId, taskId, syncMode, substrateState, substrateRevision, managedDisposition } = native;
  const createdAt = new Date().toISOString();
  const truth = {
    ...buildContractEnvelope("truth", createdAt),
    kind: "truth" as const,
    sessionKey,
    requestId: workflow.requestId,
    flowId,
    taskId,
    runtime: "openclaw-native" as const,
    syncMode,
    substrateState,
    substrateRevision,
    managedDisposition,
    ownership: {
      claimOwner,
      claimToken,
      controllerId,
    },
    scope: {
      workspaceMode: scope.workspaceMode,
      readScopeCount: scope.readScope.length,
      writeScopeCount: scope.writeScope.length,
      writeScopeSummary: scope.writeScopeSummary || "",
    },
  };
  const projection = {
    ...buildContractEnvelope("projection", createdAt),
    kind: "projection" as const,
    status: substrateState,
    runtime: "openclaw-native" as const,
    flowId,
    taskId,
    substrateState,
    substrateRevision,
    workspaceMode: scope.workspaceMode,
  };
  const artifact = {
    ...buildContractEnvelope("artifact", createdAt),
    kind: "artifact" as const,
    taskPacketRef: workflow.taskMaterialization?.taskPacketRef || `${workflow.flowId}:${workflow.taskId}`,
    schemaPlanes: createNativeTruthArtifactKinds(),
  };
  const telemetry = {
    ...buildContractEnvelope("telemetry", createdAt),
    kind: "telemetry" as const,
    substrateRevision,
    syncMode,
    claimOwner,
  };

  return {
    scope,
    claimOwner,
    claimToken,
    controllerId,
    flowId,
    taskId,
    syncMode,
    substrateState,
    substrateRevision,
    managedDisposition,
    truth,
    projection,
    artifact,
    telemetry,
  };
}

export function createRuntimeTaskflowAdapter(helperInvoker: NativeHelperInvoker = invokeNativeHelper): RuntimeTaskflowAdapter {
  const createBinding = (sessionKey: string): RuntimeTaskflowSessionBinding => ({
    sessionKey,
    bindSession: (nextSessionKey: string) => createBinding(nextSessionKey),
    createManaged: (workflow) => {
      const helperResult = helperInvoker({
        action: "create-managed-flow",
        args: {
          session_key: sessionKey,
          controller_id: workflow.claim?.claimOwner || workflow.taskMaterialization?.claimOwner || "runtime-core",
          goal: buildGoal(workflow),
          notify_policy: "silent",
          state_json: stringifyStateJson(workflow),
        },
      });
      const derived = deriveTruthShape(sessionKey, workflow, {
        flowId: helperResult.flow.flowId,
        taskId: workflow.taskId,
        syncMode: "managed",
        substrateState: helperResult.flow.status as RuntimeWorkflowState["workflowOrchestration"],
        substrateRevision: helperResult.flow.revision,
        managedDisposition: "managed",
      });
      return {
        flowId: helperResult.flow.flowId,
        controllerId: derived.controllerId,
        managed: true,
        runtime: "openclaw-native",
        syncMode: derived.syncMode,
        substrateState: derived.substrateState,
        substrateRevision: derived.substrateRevision,
        managedDisposition: derived.managedDisposition,
        ownership: {
          claimOwner: derived.claimOwner,
          claimToken: derived.claimToken,
          controllerId: derived.controllerId,
        },
        scope: derived.scope,
        truth: derived.truth,
        projection: derived.projection,
        artifact: derived.artifact,
        telemetry: derived.telemetry,
      };
    },
    runTask: (workflow) => {
      const helperResult = helperInvoker({
        action: "run-task",
        args: {
          session_key: sessionKey,
          flow_id: workflow.flowId,
          task: buildGoal(workflow),
          status: "queued",
          notify_policy: "silent",
          progress_summary: String(workflow.workflowOrchestration || "").trim(),
        },
      });
      const derived = deriveTruthShape(sessionKey, workflow, {
        flowId: helperResult.flow_id,
        taskId: helperResult.task.taskId,
        syncMode: helperResult.task.syncMode,
        substrateState: helperResult.task.state as RuntimeWorkflowState["workflowOrchestration"],
        substrateRevision: helperResult.task.revision,
        managedDisposition: helperResult.task.syncMode,
      });
      return {
        taskId: helperResult.task.taskId,
        flowId: helperResult.flow_id,
        runtime: "openclaw-native",
        syncMode: derived.syncMode,
        substrateState: derived.substrateState,
        substrateRevision: derived.substrateRevision,
        ownership: {
          claimOwner: derived.claimOwner,
          claimToken: derived.claimToken,
          controllerId: derived.controllerId,
        },
        scope: derived.scope,
        truth: derived.truth,
        projection: derived.projection,
        artifact: derived.artifact,
        telemetry: derived.telemetry,
      };
    },
  });

  return {
    bindSession: (sessionKey: string) => createBinding(sessionKey),
  };
}
