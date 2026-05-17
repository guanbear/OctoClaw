import { describe, expect, it } from "vitest";
import type { HostRuntimeAdapter, RuntimeStatusSnapshot, RuntimeDeliverySnapshot, RuntimeFallbackSnapshot } from "./types.js";

function stubAdapter(): HostRuntimeAdapter {
  return {
    host: "openclaw",
    readStatus: async () => ({ found: false, degraded: false, status: "unknown", reason: "stub" }),
    readDelivery: async () => ({ found: false, delivered: false, degraded: false, reason: "stub" }),
    readFallbacks: async () => ({ status: "unavailable", fallbackRuntimeIds: [], source: "none", observedAt: new Date().toISOString() }),
  };
}

function toRecord(adapter: HostRuntimeAdapter): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(adapter)) {
    const value = key === "host" ? adapter.host
      : key === "readStatus" ? adapter.readStatus
      : key === "readDelivery" ? adapter.readDelivery
      : key === "readFallbacks" ? adapter.readFallbacks
      : undefined;
    if (value !== undefined) rec[key] = value;
  }
  return rec;
}

function adapterMethodsOf(adapter: HostRuntimeAdapter): string[] {
  const rec = toRecord(adapter);
  return Object.keys(rec).filter((k) => typeof rec[k] === "function");
}

function adapterHasMethod(adapter: HostRuntimeAdapter, method: string): boolean {
  const rec = toRecord(adapter);
  return method in rec && typeof rec[method] === "function";
}

describe("NTR-P4-001: runtime adapter has only required methods", () => {
  const forbidden = ["spawn", "cancel", "schedule", "kill", "terminate", "restart", "reboot", "config", "configure", "mutate", "write", "create", "delete"];

  it("adapter exposes only readStatus, readDelivery, readFallbacks", () => {
    const adapter = stubAdapter();
    const methods = adapterMethodsOf(adapter);

    expect(methods.sort()).toEqual(["readDelivery", "readFallbacks", "readStatus"]);
  });

  for (const method of forbidden) {
    it(`${method} is not present on adapter`, () => {
      const adapter = stubAdapter();
      expect(adapterHasMethod(adapter, method)).toBe(false);
    });
  }
});

describe("NTR-P4-002: adapter snapshot types are host-neutral", () => {
  const status: RuntimeStatusSnapshot = {
    found: true,
    degraded: false,
    status: "running",
    runId: "run-1",
    flowId: "flow-1",
    childSessionKey: "child-1",
    reason: "test",
  };

  const delivery: RuntimeDeliverySnapshot = {
    found: true,
    delivered: true,
    degraded: false,
    messageId: "msg-1",
    channelId: "ch-1",
    reason: "test",
  };

  const fallback: RuntimeFallbackSnapshot = {
    status: "ok",
    primaryRuntimeId: "acp-primary",
    fallbackRuntimeIds: ["acp-secondary"],
    source: "openclaw_config",
    observedAt: "2026-05-17T00:00:00.000Z",
  };

  it("RuntimeStatusSnapshot required fields are host-neutral", () => {
    const requiredKeys = Object.keys(status).filter((k) => status[k as keyof RuntimeStatusSnapshot] !== undefined && !k.includes("native") && !k.includes("agent") && !k.includes("Runtime"));
    expect(requiredKeys).toContain("found");
    expect(requiredKeys).toContain("degraded");
    expect(requiredKeys).toContain("status");
    expect(requiredKeys).toContain("reason");
  });

  it("RuntimeStatusSnapshot host-specific fields are optional", () => {
    const optionalFields = ["nativeKind", "agentRuntimeId"] as const;
    for (const field of optionalFields) {
      expect(status[field]).toBeUndefined();
    }
    const withNative: RuntimeStatusSnapshot = { ...status, nativeKind: "spawn-child", agentRuntimeId: "acp-primary" };
    expect(withNative.nativeKind).toBe("spawn-child");
    expect(withNative.agentRuntimeId).toBe("acp-primary");
  });

  it("RuntimeDeliverySnapshot required fields are host-neutral", () => {
    const requiredKeys = ["found", "delivered", "degraded", "reason"];
    for (const k of requiredKeys) {
      expect(delivery[k as keyof RuntimeDeliverySnapshot]).toBeDefined();
    }
  });

  it("RuntimeFallbackSnapshot source includes both openclaw and hermes values", () => {
    const openclawSource: RuntimeFallbackSnapshot = { ...fallback, source: "openclaw_config" };
    const hermesSource: RuntimeFallbackSnapshot = { ...fallback, source: "hermes_config" };
    expect(openclawSource.source).toBe("openclaw_config");
    expect(hermesSource.source).toBe("hermes_config");
  });
});
