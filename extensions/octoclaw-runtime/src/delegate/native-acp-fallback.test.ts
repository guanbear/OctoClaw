import { describe, expect, it } from "vitest";
import {
  classifyNativeAcpFallback,
  loadNativeAcpFallbackSnapshot,
  nativeAcpFallbackMetadata,
  shouldDelegateBackendUnavailableToNative,
} from "./native-acp-fallback.js";

describe("native ACP fallback integration", () => {
  it("loads acp.fallbacks from OpenClaw config without mutation", () => {
    const config = { acp: { fallbacks: ["acpx", "codex-native"] } };

    expect(loadNativeAcpFallbackSnapshot(config, new Date("2026-05-17T00:00:00Z"))).toMatchObject({
      status: "ok",
      primaryRuntimeId: "acpx",
      fallbackRuntimeIds: ["acpx", "codex-native"],
      source: "openclaw_config",
      observedAt: "2026-05-17T00:00:00.000Z",
    });
    expect(config).toEqual({ acp: { fallbacks: ["acpx", "codex-native"] } });
  });

  it("returns unavailable when acp fallback config is not exposed", () => {
    expect(loadNativeAcpFallbackSnapshot({}, new Date("2026-05-17T00:00:00Z"))).toMatchObject({
      status: "unavailable",
      fallbackRuntimeIds: [],
      source: "none",
      reason: "native_acp_fallback_unavailable",
    });
  });

  it("records observe metadata without changing behavior", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });

    expect(nativeAcpFallbackMetadata(snapshot, "observe")).toMatchObject({
      mode: "observe",
      primaryRuntimeId: "acpx",
      fallbackRuntimeIds: ["acpx", "codex-native"],
      fallbackAttempted: false,
      fallbackSelectedRuntimeId: "",
      reason: "",
    });
  });

  it("defaults native ACP fallback mode to observe", async () => {
    const { resolveNativeAcpFallbackMode } = await import("./native-acp-fallback.js");

    expect(resolveNativeAcpFallbackMode({})).toBe("observe");
    expect(resolveNativeAcpFallbackMode({ OCTOCLAW_NATIVE_ACP_FALLBACK_MODE: "observe" })).toBe("observe");
    expect(resolveNativeAcpFallbackMode({ OCTOCLAW_NATIVE_ACP_FALLBACK_MODE: "delegate_backend_unavailable" })).toBe("delegate_backend_unavailable");
  });

  it("classifies backend unavailable before output as native fallback eligible", () => {
    const classified = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false });

    expect(classified).toEqual({
      reason: "backend_unavailable_before_output",
      nativeFallbackEligible: true,
      octoclawRecoveryOwner: false,
    });
  });

  it("does not treat after-output or timeout failures as clean native failover", () => {
    expect(classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true })).toMatchObject({
      reason: "backend_unavailable_after_output",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
    expect(classifyNativeAcpFallback({ timedOut: true, outputStarted: true })).toMatchObject({
      reason: "task_timeout",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
  });

  it("delegates only before-output backend unavailable in enforce mode", () => {
    expect(shouldDelegateBackendUnavailableToNative({
      mode: "delegate_backend_unavailable",
      classification: classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false }),
    })).toBe(true);
    expect(shouldDelegateBackendUnavailableToNative({
      mode: "observe",
      classification: classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false }),
    })).toBe(false);
    expect(shouldDelegateBackendUnavailableToNative({
      mode: "delegate_backend_unavailable",
      classification: classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true }),
    })).toBe(false);
  });
});
