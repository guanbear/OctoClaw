import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type {
  RuntimeTaskflowManagedRecord,
  RuntimeTaskflowTaskRecord,
} from "./runtime-taskflow.js";

export type RuntimeStateSurfaceRecord = RuntimeTaskflowManagedRecord | RuntimeTaskflowTaskRecord;

export interface RuntimeStateDetailsSurface {
  taskId: string;
  flowId: string;
  substrateState: string;
  substrateRevision: number;
  syncMode: "managed" | "mirrored";
  runtime: "openclaw-native";
  claimOwner: string;
  workspaceMode: string;
  writeScopeSummary?: string;
  summary: string;
  truth: RuntimeStateSurfaceRecord["truth"];
  projection: RuntimeStateSurfaceRecord["projection"];
}

function substrateSummary(record: RuntimeStateSurfaceRecord): string {
  return `${record.runtime} ${record.syncMode} ${record.substrateState}`.trim();
}

export function buildStatusSurfaceView(record: RuntimeStateSurfaceRecord): StatusSurfaceViewModel {
  return {
    ...buildContractEnvelope("projection"),
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    state: record.substrateState,
    route: record.truth.requestId ? "delegate.single" : "reply",
    workerPool: "octoclaw-runtime",
    substrateSummary: substrateSummary(record),
    actionAvailability: ["status", "details", "queue"],
    claimOwner: record.ownership.claimOwner,
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary,
  };
}

export function buildStateDetailsSurface(record: RuntimeStateSurfaceRecord): RuntimeStateDetailsSurface {
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    substrateState: record.substrateState,
    substrateRevision: record.substrateRevision,
    syncMode: record.syncMode,
    runtime: record.runtime,
    claimOwner: record.ownership.claimOwner,
    workspaceMode: record.scope.workspaceMode,
    writeScopeSummary: record.scope.writeScopeSummary,
    summary: substrateSummary(record),
    truth: record.truth,
    projection: record.projection,
  };
}
