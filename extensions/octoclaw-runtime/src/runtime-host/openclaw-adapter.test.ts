import { describe, expect, it, vi } from "vitest";
import type { NativeStatusProjection, NativeStatusProjectorInput } from "../state/native-status-projector.js";
import { createOpenClawRuntimeAdapter, normalizeNativeDeliveryToSnapshot, adapterFallbackToNativeSnapshot, statusSnapshotToNativeProjection } from "./openclaw-adapter.js";
import { deliveryRelayVerdict } from "../im/delivery-relay-verdict.js";
import { loadNativeAcpFallbackSnapshot } from "../delegate/native-acp-fallback.js";

function stubProjection(overrides: Partial<NativeStatusProjection> = {}): NativeStatusProjection {
  return {
    status: "running",
    rawStatus: "running",
    source: "run",
    reason: "resolved_by_openclaw_run_id",
    found: true,
    degraded: false,
    runId: "run-1",
    ...overrides,
  };
}

function stubDeps(overrides: { projection?: NativeStatusProjection; projectStatus?: (input: NativeStatusProjectorInput) => Promise<NativeStatusProjection> } = {}) {
  return {
    projectStatus: overrides.projectStatus ?? (async (_input: NativeStatusProjectorInput) =>
      overrides.projection ?? stubProjection()),
    readFallbacks: async () =>
      loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } }),
  };
}

describe("NTR-P4-003: OpenClaw adapter preserves native status projection", () => {
  it("maps spawn-child record with agentRuntime.id to correct snapshot", async () => {
    const projection = stubProjection({
      status: "running",
      rawStatus: "running",
      nativeKind: "spawn-child",
      agentRuntimeId: "acp-primary",
      runId: "run-1",
      flowId: "flow-1",
      childSessionKey: "child-1",
    });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-1" });

    expect(snapshot).toMatchObject({
      found: true,
      degraded: false,
      status: "running",
      runId: "run-1",
      flowId: "flow-1",
      childSessionKey: "child-1",
      nativeKind: "spawn-child",
      agentRuntimeId: "acp-primary",
    });
  });

  it("maps completed to succeeded", async () => {
    const projection = stubProjection({ status: "completed", rawStatus: "completed" });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-1" });

    expect(snapshot.status).toBe("succeeded");
    expect(statusSnapshotToNativeProjection(snapshot).status).toBe("completed");
  });

  it("maps canceled to cancelled", async () => {
    const projection = stubProjection({ status: "canceled", rawStatus: "canceled" });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-1" });

    expect(snapshot.status).toBe("cancelled");
    expect(statusSnapshotToNativeProjection(snapshot).status).toBe("canceled");
  });

  it("maps degraded to unknown", async () => {
    const projection = stubProjection({ status: "degraded", degraded: true });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-1" });

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.degraded).toBe(true);
    expect(statusSnapshotToNativeProjection(snapshot).status).toBe("degraded");
  });

  it("forwards full status refs to the native projector", async () => {
    const projectStatus = vi.fn(async () => stubProjection());
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projectStatus }));

    await adapter.readStatus({
      ctx: { marker: "ctx" },
      sessionKey: "session-1",
      workContractId: "wc-1",
      taskId: "task-1",
      runId: "run-1",
      flowId: "flow-1",
      childSessionKey: "child-1",
      cache: { status: "running", summary: "cached" },
      allowFindLatest: false,
    });

    expect(projectStatus).toHaveBeenCalledWith({
      ctx: { marker: "ctx" },
      sessionKey: "session-1",
      workContractId: "wc-1",
      openclawTaskId: "task-1",
      openclawRunId: "run-1",
      openclawFlowId: "flow-1",
      childSessionKey: "child-1",
      cache: { status: "running", summary: "cached" },
      allowFindLatest: false,
    });
  });

  it("maps not-found projection correctly", async () => {
    const projection = stubProjection({ found: false, status: "unknown", reason: "native_not_found" });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-nonexistent" });

    expect(snapshot.found).toBe(false);
    expect(snapshot.status).toBe("unknown");
  });

  it("does not consult legacy heuristics", async () => {
    const projection = stubProjection({
      status: "running",
      source: "run",
      reason: "resolved_by_openclaw_run_id",
    });
    const adapter = createOpenClawRuntimeAdapter(stubDeps({ projection }));

    const snapshot = await adapter.readStatus({ runId: "run-1" });

    expect(snapshot.reason).toBe("resolved_by_openclaw_run_id");
  });
});

describe("NTR-P4-004: OpenClaw adapter delivery snapshot preserves delivery verdict", () => {
  it("readDelivery without live lookup source returns unavailable snapshot", async () => {
    const adapter = createOpenClawRuntimeAdapter(stubDeps());

    const snapshot = await adapter.readDelivery({ runId: "run-1" });

    expect(snapshot).toMatchObject({
      found: false,
      delivered: false,
      degraded: false,
      reason: "native_delivery_lookup_unavailable",
    });
  });

  it("readDelivery does not treat ref as delivery payload", async () => {
    const adapter = createOpenClawRuntimeAdapter(stubDeps());

    const snapshot = await adapter.readDelivery({ runId: "run-1", flowId: "flow-1", childSessionKey: "child-1" });

    expect(snapshot.found).toBe(false);
    expect(snapshot.delivered).toBe(false);
  });

  it("delivered native delivery normalized produces nativeDelivered=true and no compensation", () => {
    const snapshot = normalizeNativeDeliveryToSnapshot({
      status: "delivered",
      messageId: "msg-1",
      channelId: "C123",
      resultHash: "hash-1",
    });

    expect(snapshot).toMatchObject({
      found: true,
      delivered: true,
      degraded: false,
      status: "delivered",
      messageId: "msg-1",
      channelId: "C123",
      resultHash: "hash-1",
      reason: "native_delivery_success",
    });

    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "msg-1" },
    });

    expect(verdict.nativeDelivered).toBe(true);
    expect(verdict.relayCompensationNeeded).toBe(false);
    expect(verdict.source).toBe("native_delivery");
  });

  it("failed native delivery produces delivered=false", () => {
    const snapshot = normalizeNativeDeliveryToSnapshot({
      status: "failed",
      error: "channel_not_found",
    });

    expect(snapshot).toMatchObject({
      found: true,
      delivered: false,
      degraded: false,
      reason: "native_delivery_failed",
    });
  });

  it("degraded native delivery produces degraded=true", () => {
    const snapshot = normalizeNativeDeliveryToSnapshot({
      status: "degraded",
      error: "uncertain",
    });

    expect(snapshot).toMatchObject({
      found: true,
      delivered: false,
      degraded: true,
    });
  });

  it("no native delivery data produces found=false", () => {
    const snapshot = normalizeNativeDeliveryToSnapshot(undefined);

    expect(snapshot).toMatchObject({
      found: false,
      delivered: false,
      reason: "no_native_delivery_data",
    });
  });
});

describe("NTR-P4-005: OpenClaw adapter fallback snapshot preserves ids", () => {
  it("preserves primary and fallback ids from native data", async () => {
    const config = { acp: { fallbacks: ["acp-primary", "acp-secondary"] } };
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot(config, new Date("2026-05-17T00:00:00Z")),
    });

    const snapshot = await adapter.readFallbacks();

    expect(snapshot).toMatchObject({
      status: "ok",
      primaryRuntimeId: "acp-primary",
      fallbackRuntimeIds: ["acp-primary", "acp-secondary"],
      source: "openclaw_config",
    });
  });

  it("does not mutate input config", async () => {
    const config = { acp: { fallbacks: ["acpx", "codex-native"] } };
    const before = JSON.stringify(config);
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot(config),
    });

    await adapter.readFallbacks();

    expect(JSON.stringify(config)).toBe(before);
  });

  it("unavailable config maps correctly", async () => {
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot({}),
    });

    const snapshot = await adapter.readFallbacks();

    expect(snapshot).toMatchObject({
      status: "unavailable",
      fallbackRuntimeIds: [],
      source: "none",
    });
  });

  it("returns a copy of fallbackRuntimeIds", async () => {
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["a", "b"] } }),
    });

    const snap1 = await adapter.readFallbacks();
    const snap2 = await adapter.readFallbacks();

    expect(snap1.fallbackRuntimeIds).toEqual(snap2.fallbackRuntimeIds);
    expect(snap1.fallbackRuntimeIds).not.toBe(snap2.fallbackRuntimeIds);
  });
});

describe("NTR-P4-B: adapter fallback round-trip preserves NativeAcpFallbackSnapshot shape", () => {
  it("round-trips ok config with fallbacks to native snapshot", async () => {
    const config = { acp: { fallbacks: ["acpx", "codex-native"] } };
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot(config, new Date("2026-05-17T00:00:00Z")),
    });

    const adapterSnapshot = await adapter.readFallbacks();
    const nativeSnapshot = adapterFallbackToNativeSnapshot(adapterSnapshot);

    expect(nativeSnapshot).toMatchObject({
      status: "ok",
      primaryRuntimeId: "acpx",
      fallbackRuntimeIds: ["acpx", "codex-native"],
      source: "openclaw_config",
    });
  });

  it("round-trips unavailable config restoring empty primaryRuntimeId", async () => {
    const config = {};
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot(config),
    });

    const adapterSnapshot = await adapter.readFallbacks();
    const nativeSnapshot = adapterFallbackToNativeSnapshot(adapterSnapshot);

    expect(nativeSnapshot.primaryRuntimeId).toBe("");
    expect(nativeSnapshot.fallbackRuntimeIds).toEqual([]);
    expect(nativeSnapshot.source).toBe("none");
  });

  it("round-trip produces metadata identical to direct readNativeAcpFallbackSnapshot", async () => {
    const config = { acp: { fallbacks: ["acp-primary", "acp-secondary"] } };
    const adapter = createOpenClawRuntimeAdapter({
      readFallbacks: async () => loadNativeAcpFallbackSnapshot(config, new Date("2026-05-17T00:00:00Z")),
    });
    const directSnapshot = loadNativeAcpFallbackSnapshot(config, new Date("2026-05-17T00:00:00Z"));

    const nativeSnapshot = adapterFallbackToNativeSnapshot(await adapter.readFallbacks());

    expect(nativeSnapshot.status).toBe(directSnapshot.status);
    expect(nativeSnapshot.primaryRuntimeId).toBe(directSnapshot.primaryRuntimeId);
    expect(nativeSnapshot.fallbackRuntimeIds).toEqual(directSnapshot.fallbackRuntimeIds);
    expect(nativeSnapshot.source).toBe(directSnapshot.source);
  });
});
