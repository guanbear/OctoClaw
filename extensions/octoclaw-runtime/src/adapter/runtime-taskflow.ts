import type { RuntimeWorkflowState } from "../../../../packages/octoclaw-runtime-core/src/workflow/index.ts";
import {
  buildContractEnvelope,
  type ScopeMetadata,
  type WorkspaceMode,
} from "../../../../packages/octoclaw-contracts/src/schemas.ts";
import { createNativeTruthArtifactKinds } from "../../../../packages/octoclaw-contracts/src/artifacts.ts";

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

function normalizeScope(scope: ScopeMetadata): ScopeMetadata {
  return {
    readScope: Array.isArray(scope?.readScope) ? scope.readScope : [],
    writeScope: Array.isArray(scope?.writeScope) ? scope.writeScope : [],
    workspaceMode: scope?.workspaceMode || "isolated_workspace",
    writeScopeSummary: scope?.writeScopeSummary,
  };
}

function deriveTruthShape(sessionKey: string, workflow: RuntimeWorkflowState) {
  const scope = normalizeScope(workflow.scope);
  const claimOwner = workflow.claim?.claimOwner || workflow.taskMaterialization?.claimOwner || "runtime-core";
  const claimToken = workflow.claim?.claimToken || workflow.taskMaterialization?.claimToken || "";
  const controllerId = claimOwner || "runtime-core";
  const substrateRevision = 0;
  const syncMode = "managed" as const;
  const substrateState = workflow.workflowOrchestration;
  const createdAt = new Date().toISOString();
  const truth = {
    ...buildContractEnvelope("truth", createdAt),
    kind: "truth" as const,
    sessionKey,
    requestId: workflow.requestId,
    flowId: workflow.flowId,
    taskId: workflow.taskId,
    runtime: "openclaw-native" as const,
    syncMode,
    substrateState,
    substrateRevision,
    managedDisposition: "managed" as const,
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
    status: workflow.workflowOrchestration,
    runtime: "openclaw-native" as const,
    flowId: workflow.flowId,
    taskId: workflow.taskId,
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
    syncMode,
    substrateState,
    substrateRevision,
    truth,
    projection,
    artifact,
    telemetry,
  };
}

export function createRuntimeTaskflowAdapter(): RuntimeTaskflowAdapter {
  const createBinding = (sessionKey: string): RuntimeTaskflowSessionBinding => ({
    sessionKey,
    bindSession: (nextSessionKey: string) => createBinding(nextSessionKey),
    createManaged: (workflow) => {
      const derived = deriveTruthShape(sessionKey, workflow);
      return {
        flowId: workflow.flowId,
        controllerId: derived.controllerId,
        managed: true,
        runtime: "openclaw-native",
        syncMode: derived.syncMode,
        substrateState: derived.substrateState,
        substrateRevision: derived.substrateRevision,
        managedDisposition: "managed",
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
      const derived = deriveTruthShape(sessionKey, workflow);
      return {
        taskId: workflow.taskId,
        flowId: workflow.flowId,
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
