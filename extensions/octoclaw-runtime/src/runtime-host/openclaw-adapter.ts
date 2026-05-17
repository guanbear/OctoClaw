import type { RuntimeStatusSnapshot, RuntimeDeliverySnapshot, RuntimeFallbackSnapshot, HostRuntimeAdapter } from "./types.js";
import type { NativeProjectedStatus, NativeStatusProjection, NativeStatusProjectorInput, NativeStatusSource } from "../state/native-status-projector.js";
import { projectNativeStatus } from "../state/native-status-projector.js";
import { readNativeAcpFallbackSnapshot, type NativeAcpFallbackSnapshot } from "../delegate/native-acp-fallback.js";

type AdapterStatus = RuntimeStatusSnapshot["status"];

function mapNativeStatus(status: string): AdapterStatus {
  if (status === "canceled") return "cancelled";
  if (status === "completed") return "succeeded";
  if (status === "degraded") return "unknown";
  if ([
    "queued", "running", "failed", "timed_out", "lost", "unknown",
  ].includes(status)) return status as AdapterStatus;
  return "unknown";
}

function nativeProjectionToStatusSnapshot(projection: NativeStatusProjection): RuntimeStatusSnapshot {
  return {
    found: projection.found,
    degraded: projection.degraded,
    status: mapNativeStatus(projection.status),
    rawStatus: projection.rawStatus,
    source: projection.source,
    nativeStatus: projection.status,
    runId: projection.runId,
    flowId: projection.flowId,
    taskId: projection.taskId,
    childSessionKey: projection.childSessionKey,
    nativeKind: projection.nativeKind,
    agentRuntimeId: projection.agentRuntimeId,
    summary: projection.summary,
    revision: projection.revision,
    error: projection.error,
    reason: projection.reason,
  };
}

function nativeProjectedStatus(value: unknown): NativeProjectedStatus {
  const status = String(value);
  if (["queued", "running", "completed", "failed", "timed_out", "canceled", "unknown", "lost", "degraded"].includes(status)) {
    return status as NativeProjectedStatus;
  }
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "canceled";
  return "unknown";
}

function nativeStatusSource(value: unknown): NativeStatusSource {
  const source = String(value);
  if (["run", "flow", "latest", "cache", "none"].includes(source)) return source as NativeStatusSource;
  return "none";
}

export function statusSnapshotToNativeProjection(snapshot: RuntimeStatusSnapshot): NativeStatusProjection {
  const status = nativeProjectedStatus(snapshot.nativeStatus ?? snapshot.status);
  return {
    status,
    rawStatus: snapshot.rawStatus || snapshot.nativeStatus || snapshot.status,
    source: nativeStatusSource(snapshot.source),
    reason: snapshot.reason,
    found: snapshot.found,
    degraded: snapshot.degraded,
    runId: snapshot.runId,
    flowId: snapshot.flowId,
    taskId: snapshot.taskId,
    childSessionKey: snapshot.childSessionKey,
    nativeKind: snapshot.nativeKind,
    agentRuntimeId: snapshot.agentRuntimeId,
    summary: snapshot.summary,
    revision: snapshot.revision,
    error: snapshot.error,
  };
}

function normalizeDeliverySnapshot(input: {
  nativeDelivery?: unknown;
}): RuntimeDeliverySnapshot {
  const delivery = input.nativeDelivery;
  if (typeof delivery === "object" && delivery !== null) {
    const rec = delivery as Record<string, unknown>;
    const status = String(rec.status || rec.deliveryStatus || "").toLowerCase();
    const delivered = status === "delivered";
    const messageId = rec.messageId ? String(rec.messageId) : undefined;
    const channelId = rec.channelId ? String(rec.channelId) : undefined;
    return {
      found: true,
      delivered,
      degraded: status === "degraded" || status === "unknown",
      messageId,
      channelId,
      reason: delivered ? "native_delivery_success" : status ? `native_delivery_${status}` : "native_delivery_pending",
    };
  }
  return {
    found: false,
    delivered: false,
    degraded: false,
    reason: "no_native_delivery_data",
  };
}

function nativeFallbackToAdapterSnapshot(snapshot: NativeAcpFallbackSnapshot): RuntimeFallbackSnapshot {
  return {
    status: snapshot.status,
    primaryRuntimeId: snapshot.primaryRuntimeId || undefined,
    fallbackRuntimeIds: [...snapshot.fallbackRuntimeIds],
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    reason: snapshot.reason,
  };
}

const DELIVERY_LOOKUP_UNAVAILABLE: RuntimeDeliverySnapshot = {
  found: false,
  delivered: false,
  degraded: false,
  reason: "native_delivery_lookup_unavailable",
};

export interface OpenClawAdapterDeps {
  projectStatus: (input: NativeStatusProjectorInput) => Promise<NativeStatusProjection>;
  readDelivery?: (ref: { runId?: string; flowId?: string; childSessionKey?: string }) => Promise<RuntimeDeliverySnapshot>;
  readFallbacks: (input?: { openclawHome?: string }) => Promise<NativeAcpFallbackSnapshot>;
}

export function createOpenClawRuntimeAdapter(deps?: Partial<OpenClawAdapterDeps>): HostRuntimeAdapter {
  const projectStatus = deps?.projectStatus ?? projectNativeStatus;
  const readDeliveryFromDeps = deps?.readDelivery;
  const readFallbackSnapshot = deps?.readFallbacks ?? (async (input) => readNativeAcpFallbackSnapshot(input));

  return {
    host: "openclaw",
    async readStatus(ref) {
      const projection = await projectStatus({
        ctx: ref.ctx,
        sessionKey: ref.sessionKey,
        workContractId: ref.workContractId,
        openclawTaskId: ref.taskId,
        openclawRunId: ref.runId,
        openclawFlowId: ref.flowId,
        childSessionKey: ref.childSessionKey,
        cache: ref.cache,
        allowFindLatest: ref.allowFindLatest,
      });
      return nativeProjectionToStatusSnapshot(projection);
    },
    async readDelivery(ref) {
      if (readDeliveryFromDeps) return readDeliveryFromDeps(ref);
      return { ...DELIVERY_LOOKUP_UNAVAILABLE };
    },
    async readFallbacks() {
      const snapshot = await readFallbackSnapshot();
      return nativeFallbackToAdapterSnapshot(snapshot);
    },
  };
}

export function normalizeNativeDeliveryToSnapshot(nativeDelivery: unknown): RuntimeDeliverySnapshot {
  return normalizeDeliverySnapshot({ nativeDelivery });
}

/** Reverse of nativeFallbackToAdapterSnapshot: restores required string primaryRuntimeId and narrows source. */
export function adapterFallbackToNativeSnapshot(
  snapshot: RuntimeFallbackSnapshot,
): NativeAcpFallbackSnapshot {
  return {
    status: snapshot.status,
    primaryRuntimeId: snapshot.primaryRuntimeId ?? "",
    fallbackRuntimeIds: [...snapshot.fallbackRuntimeIds],
    source: snapshot.source === "hermes_config" ? "none" : snapshot.source,
    observedAt: snapshot.observedAt,
    reason: snapshot.reason,
  };
}
