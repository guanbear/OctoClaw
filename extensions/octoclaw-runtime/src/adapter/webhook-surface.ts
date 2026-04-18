import type { RuntimeWorkflowState } from "@octoclaw/runtime-core/workflow";
import type {
  RuntimeTaskflowAdapter,
  RuntimeTaskflowManagedRecord,
  RuntimeTaskflowTaskRecord,
} from "./runtime-taskflow.js";
import { createRuntimeTaskflowAdapter } from "./runtime-taskflow.js";
import type { NativeHelperInvoker } from "./native-helper.js";
import { resolveRuntimeConfig, type OctoClawRuntimeConfig } from "../config/index.js";
import {
  buildStateDetailsSurface,
  buildStatusSurfaceView,
  type RuntimeStateDetailsSurface,
  type RuntimeStateSurfaceRecord,
} from "./state-surface.js";
import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";

export interface WebhookCreateManagedInput {
  sessionKey: string;
  workflow: RuntimeWorkflowState;
}

export interface WebhookRunTaskInput {
  sessionKey: string;
  workflow: RuntimeWorkflowState;
}

export interface WebhookCancelFlowInput {
  sessionKey: string;
  flowId: string;
}

export interface WebhookRuntimeStateView {
  taskId: string;
  flowId: string;
  substrateState: string;
  substrateRevision: number;
  syncMode: "managed" | "mirrored";
  runtime: "openclaw-native";
  summary: string;
  truth: RuntimeTaskflowTaskRecord["truth"] | RuntimeTaskflowManagedRecord["truth"];
  projection: RuntimeTaskflowTaskRecord["projection"] | RuntimeTaskflowManagedRecord["projection"];
}

export interface WebhookReadFlowInput {
  sessionKey: string;
  flowId: string;
}

export interface WebhookCancelResult {
  ok: boolean;
  status: string;
  flowId: string;
  found: boolean;
  cancelled: boolean;
  reason: string;
}

export interface RuntimeWebhookSurface {
  config: OctoClawRuntimeConfig;
  createManaged: (input: WebhookCreateManagedInput) => RuntimeTaskflowManagedRecord;
  runTask: (input: WebhookRunTaskInput) => RuntimeTaskflowTaskRecord;
  cancelFlow: (input: WebhookCancelFlowInput) => WebhookCancelResult;
  readFlowState: (input: WebhookReadFlowInput) => {
    ok: boolean;
    status: string;
    flowId: string;
    found: boolean;
    substrateState: string | null;
    substrateRevision: number | null;
    currentStep?: string;
    summary: string;
  };
  readTaskState: (input: { sessionKey: string; flowId: string; taskId: string }) => {
    ok: boolean;
    status: string;
    flowId: string;
    taskId: string;
    found: boolean;
    substrateState: string | null;
    substrateRevision: number | null;
    syncMode?: "managed" | "mirrored";
    progressSummary?: string;
    summary: string;
  };
  readManaged: (record: RuntimeTaskflowManagedRecord) => WebhookRuntimeStateView;
  readTask: (record: RuntimeTaskflowTaskRecord) => WebhookRuntimeStateView;
  readStatusView: (record: RuntimeTaskflowManagedRecord | RuntimeTaskflowTaskRecord) => StatusSurfaceViewModel;
  readDetailsView: (record: RuntimeTaskflowManagedRecord | RuntimeTaskflowTaskRecord) => RuntimeStateDetailsSurface;
}

function summarizeState(taskId: string, flowId: string, substrateState: string): string {
  return `${taskId} on ${flowId} is ${substrateState}`;
}

function normalizeManagedView(record: RuntimeTaskflowManagedRecord): WebhookRuntimeStateView {
  return {
    taskId: record.truth.taskId,
    flowId: record.flowId,
    substrateState: record.substrateState,
    substrateRevision: record.substrateRevision,
    syncMode: record.syncMode,
    runtime: record.runtime,
    summary: summarizeState(record.truth.taskId, record.flowId, record.substrateState),
    truth: record.truth,
    projection: record.projection,
  };
}

function normalizeTaskView(record: RuntimeTaskflowTaskRecord): WebhookRuntimeStateView {
  return {
    taskId: record.taskId,
    flowId: record.flowId,
    substrateState: record.substrateState,
    substrateRevision: record.substrateRevision,
    syncMode: record.syncMode,
    runtime: record.runtime,
    summary: summarizeState(record.taskId, record.flowId, record.substrateState),
    truth: record.truth,
    projection: record.projection,
  };
}

function asRuntimeStateSurfaceRecord(
  record: RuntimeTaskflowManagedRecord | RuntimeTaskflowTaskRecord,
): RuntimeStateSurfaceRecord {
  return record;
}

function buildCancelInvoker(helperInvoker: NativeHelperInvoker | undefined) {
  return (input: WebhookCancelFlowInput): WebhookCancelResult => {
    if (!helperInvoker) {
      throw new Error("cancel_flow_helper_missing");
    }
    const payload = helperInvoker({
      action: "cancel-flow",
      args: {
        session_key: input.sessionKey,
        flow_id: input.flowId,
      },
    });

    return {
      ok: payload.ok,
      status: payload.status,
      flowId: payload.flow_id,
      found: payload.found,
      cancelled: payload.cancelled,
      reason: payload.reason,
    };
  };
}

export function createRuntimeWebhookSurface(
  options: {
    helperInvoker?: NativeHelperInvoker;
    adapter?: RuntimeTaskflowAdapter;
    config?: Partial<OctoClawRuntimeConfig>;
  } = {},
): RuntimeWebhookSurface {
  const config = resolveRuntimeConfig(options.config);
  const adapter = options.adapter || createRuntimeTaskflowAdapter(options.helperInvoker);
  const cancelFlow = buildCancelInvoker(options.helperInvoker);

  return {
    config,
    createManaged: ({ sessionKey, workflow }) => adapter.bindSession(sessionKey).createManaged(workflow),
    runTask: ({ sessionKey, workflow }) => adapter.bindSession(sessionKey).runTask(workflow),
    cancelFlow,
    readFlowState: ({ sessionKey, flowId }) => {
      const result = adapter.bindSession(sessionKey).readFlow(flowId);
      return {
        ...result,
        summary: result.found && result.substrateState
          ? `flow ${result.flowId} is ${result.substrateState}`
          : `flow ${result.flowId} not found`,
      };
    },
    readTaskState: ({ sessionKey, flowId, taskId }) => {
      const result = adapter.bindSession(sessionKey).readTask(flowId, taskId);
      return {
        ...result,
        summary: result.found && result.substrateState
          ? `task ${result.taskId} on ${result.flowId} is ${result.substrateState}`
          : `task ${result.taskId} on ${result.flowId} not found`,
      };
    },
    readManaged: normalizeManagedView,
    readTask: normalizeTaskView,
    readStatusView: (record) => buildStatusSurfaceView(asRuntimeStateSurfaceRecord(record)),
    readDetailsView: (record) => buildStateDetailsSurface(asRuntimeStateSurfaceRecord(record)),
  };
}
