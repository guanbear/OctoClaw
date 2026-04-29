import type { RuntimeWorkflowState } from "../core/workflow/index.js";
import {
  buildContractEnvelope,
  type ScopeMetadata,
  type WorkspaceMode,
} from "@octoclaw/contracts/schemas";
import { createNativeTruthArtifactKinds } from "@octoclaw/contracts/artifacts";
import { invokeNativeHelper, type NativeHelperInvoker } from "./native-helper.js";

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
  runId?: string;
  childRunId?: string;
  childSessionKey?: string;
  childSessionId?: string;
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
  runId?: string;
  childRunId?: string;
  childSessionKey?: string;
  childSessionId?: string;
}

export interface RuntimeTaskflowSessionBinding {
  sessionKey: string;
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
  createManaged: (workflow: RuntimeWorkflowState) => RuntimeTaskflowManagedRecord;
  runTask: (workflow: RuntimeWorkflowState) => RuntimeTaskflowTaskRecord;
  cancelFlow: (flowId: string) => {
    ok: boolean;
    status: string;
    flowId: string;
    found: boolean;
    cancelled: boolean;
    reason: string;
  };
  readFlow: (flowId: string) => {
    ok: boolean;
    status: string;
    flowId: string;
    found: boolean;
    substrateState: string | null;
    substrateRevision: number | null;
    currentStep?: string;
  };
  readTask: (flowId: string, taskId: string) => {
    ok: boolean;
    status: string;
    flowId: string;
    taskId: string;
    found: boolean;
    substrateState: string | null;
    substrateRevision: number | null;
    syncMode?: "managed" | "mirrored";
    progressSummary?: string;
  };
}

export interface RuntimeTaskflowAdapter {
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
}

function workflowIdentity(workflow: RuntimeWorkflowState): RuntimeWorkflowState["identity"] {
  return workflow.identity ?? {
    requestId: (workflow as unknown as { requestId?: string }).requestId || "",
    taskId: (workflow as unknown as { taskId?: string }).taskId || "",
    flowId: (workflow as unknown as { flowId?: string }).flowId || "",
    route: (workflow.taskMaterialization?.route || "delegate") as RuntimeWorkflowState["identity"]["route"],
    authority: (workflow.taskMaterialization?.authority || "runtime_orchestrator") as RuntimeWorkflowState["identity"]["authority"],
    backend: (workflow.taskMaterialization?.backend || "openclaw-native") as RuntimeWorkflowState["identity"]["backend"],
    materializationIntent: (workflow.taskMaterialization?.materializationIntent || "spawn_single") as RuntimeWorkflowState["identity"]["materializationIntent"],
  };
}

function workflowLifecycle(workflow: RuntimeWorkflowState): RuntimeWorkflowState["lifecycle"] {
  return workflow.lifecycle ?? {
    phase: workflow.workflowOrchestration === "running" ? "running" : "materialization_pending",
    deliveryState: "not_started",
    checkpointState: "none",
  };
}

function stringifyStateJson(workflow: RuntimeWorkflowState): string {
  const identity = workflowIdentity(workflow);
  const lifecycle = workflowLifecycle(workflow);
  return JSON.stringify({
    requestId: identity.requestId,
    taskId: identity.taskId,
    flowId: identity.flowId,
    route: identity.route,
    authority: identity.authority,
    materializationIntent: identity.materializationIntent,
    workflowOrchestration: workflow.workflowOrchestration,
    reconcileOrRecovery: workflow.reconcileOrRecovery,
    lifecyclePhase: lifecycle.phase,
    deliveryState: lifecycle.deliveryState,
  });
}

function buildGoal(workflow: RuntimeWorkflowState): string {
  const identity = workflowIdentity(workflow);
  return String(
    workflow.taskMaterialization?.taskPacketRef
      || identity.requestId
      || identity.taskId
      || identity.flowId,
  ).trim();
}

function normalizeScope(scope: ScopeMetadata): ScopeMetadata {
  return {
    readScope: Array.isArray(scope?.readScope) ? scope.readScope : [],
    writeScope: Array.isArray(scope?.writeScope) ? scope.writeScope : [],
    workspaceMode: scope?.workspaceMode || "isolated_worktree",
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
  const identity = workflowIdentity(workflow);
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
    requestId: identity.requestId,
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
    taskPacketRef: workflow.taskMaterialization?.taskPacketRef || `${identity.flowId}:${identity.taskId}`,
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
  const createBinding = (sessionKey: string): RuntimeTaskflowSessionBinding => {
    let managedFlowId: string | null = null;
    return {
      sessionKey,
      bindSession: (nextSessionKey: string) => createBinding(nextSessionKey),
      createManaged: (workflow) => {
        const identity = workflowIdentity(workflow);
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
        managedFlowId = helperResult.flow.flowId;
        const derived = deriveTruthShape(sessionKey, workflow, {
          flowId: helperResult.flow.flowId,
          taskId: identity.taskId,
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
        const identity = workflowIdentity(workflow);
        const flowId = managedFlowId || identity.flowId;
        const goal = buildGoal(workflow);
        const initialStatus = (workflow.workflowOrchestration === "completed" || workflow.workflowOrchestration === "failed")
          ? workflow.workflowOrchestration
          : workflow.workflowOrchestration === "running"
            ? "running"
            : "queued";
        const helperResult = helperInvoker({
          action: "run-task",
          args: {
            session_key: sessionKey,
            flow_id: flowId,
            task: goal,
            status: initialStatus,
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
        runId: helperResult.task.runId,
        childRunId: helperResult.task.childRunId,
        childSessionKey: helperResult.task.childSessionKey,
        childSessionId: helperResult.task.childSessionId,
      };
    },
    cancelFlow: (flowId) => {
      const helperResult = helperInvoker({
        action: "cancel-flow",
        args: {
          session_key: sessionKey,
          flow_id: flowId,
        },
      });
      return {
        ok: helperResult.ok,
        status: helperResult.status,
        flowId: helperResult.flow_id,
        found: helperResult.found,
        cancelled: helperResult.cancelled,
        reason: helperResult.reason,
      };
    },
    readFlow: (flowId) => {
      const helperResult = helperInvoker({
        action: "read-flow",
        args: {
          session_key: sessionKey,
          flow_id: flowId,
        },
      });
      return {
        ok: helperResult.ok,
        status: helperResult.status,
        flowId: helperResult.flow_id,
        found: helperResult.found,
        substrateState: helperResult.flow?.status || null,
        substrateRevision: helperResult.flow?.revision ?? null,
        currentStep: helperResult.flow?.currentStep,
      };
    },
    readTask: (flowId, taskId) => {
      const helperResult = helperInvoker({
        action: "read-task",
        args: {
          session_key: sessionKey,
          flow_id: flowId,
          task_id: taskId,
        },
      });
      return {
        ok: helperResult.ok,
        status: helperResult.status,
        flowId: helperResult.flow_id,
        taskId: helperResult.task_id,
        found: helperResult.found,
        substrateState: helperResult.task?.state || helperResult.task?.status || null,
        substrateRevision: helperResult.task?.revision ?? null,
        syncMode: helperResult.task?.syncMode,
        progressSummary: helperResult.task?.progressSummary,
      };
    },
  };
  };

  return {
    bindSession: (sessionKey: string) => createBinding(sessionKey),
  };
}
