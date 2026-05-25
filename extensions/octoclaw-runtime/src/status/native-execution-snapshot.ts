import type { NativeProjectedStatus, NativeStatusProjection, NativeStatusSource } from "../state/native-status-projector.js";

export interface NativeExecutionSnapshot {
  runAccepted: boolean;
  status: NativeProjectedStatus;
  source: NativeStatusSource;
  runId?: string;
  taskId?: string;
  flowId?: string;
  childSessionKey?: string;
  nativeAnnounceDelivered?: boolean;
  finalResultExists?: boolean;
  observedAt?: string;
}

const AUTHORITATIVE_NATIVE_SOURCES = new Set<NativeStatusSource>(["run", "flow", "latest"]);

export function buildNativeExecutionSnapshot(
  projection: NativeStatusProjection | undefined,
  extras: {
    nativeAnnounceDelivered?: boolean;
    finalResultExists?: boolean;
    observedAt?: string;
  } = {},
): NativeExecutionSnapshot {
  const source = projection?.source ?? "none";
  const runAccepted = Boolean(projection?.found && AUTHORITATIVE_NATIVE_SOURCES.has(source));
  return {
    runAccepted,
    status: projection?.status ?? "unknown",
    source,
    runId: projection?.runId,
    taskId: projection?.taskId,
    flowId: projection?.flowId,
    childSessionKey: projection?.childSessionKey,
    nativeAnnounceDelivered: extras.nativeAnnounceDelivered,
    finalResultExists: extras.finalResultExists,
    observedAt: extras.observedAt,
  };
}

export function isNativeLifecycleAuthoritative(snapshot: NativeExecutionSnapshot): boolean {
  return snapshot.runAccepted && ["queued", "running", "completed", "failed", "timed_out", "canceled"].includes(snapshot.status);
}
