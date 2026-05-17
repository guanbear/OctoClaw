import { describe, expect, it } from "vitest";
import {
  buildEnforceFallbackReplayMetadata,
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

  it("classifies bad_result as recovery owned and not native fallback eligible", () => {
    const classified = classifyNativeAcpFallback({ badResult: true });

    expect(classified).toEqual({
      reason: "bad_result",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
  });

  it("classifies policy_violation as recovery owned and not native fallback eligible", () => {
    const classified = classifyNativeAcpFallback({ policyViolation: true });

    expect(classified).toEqual({
      reason: "policy_violation",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
  });

  it("classifies no failure as reason none with octoclaw recovery ownership", () => {
    const classified = classifyNativeAcpFallback({});

    expect(classified).toEqual({
      reason: "none",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
  });

  it("NTR-P2-006: task_timeout is not native fallback eligible and remains OctoClaw recovery owned", () => {
    const classified = classifyNativeAcpFallback({ timedOut: true });

    expect(classified).toEqual({
      reason: "task_timeout",
      nativeFallbackEligible: false,
      octoclawRecoveryOwner: true,
    });
    expect(shouldDelegateBackendUnavailableToNative({
      mode: "delegate_backend_unavailable",
      classification: classified,
    })).toBe(false);
  });

  it("shouldDelegateBackendUnavailableToNative rejects all non-before-output reasons in enforce mode", () => {
    const mode = "delegate_backend_unavailable";

    const afterOutput = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true });
    const timeout = classifyNativeAcpFallback({ timedOut: true });
    const badResult = classifyNativeAcpFallback({ badResult: true });
    const policyViolation = classifyNativeAcpFallback({ policyViolation: true });
    const none = classifyNativeAcpFallback({});

    expect(shouldDelegateBackendUnavailableToNative({ mode, classification: afterOutput })).toBe(false);
    expect(shouldDelegateBackendUnavailableToNative({ mode, classification: timeout })).toBe(false);
    expect(shouldDelegateBackendUnavailableToNative({ mode, classification: badResult })).toBe(false);
    expect(shouldDelegateBackendUnavailableToNative({ mode, classification: policyViolation })).toBe(false);
    expect(shouldDelegateBackendUnavailableToNative({ mode, classification: none })).toBe(false);
  });

  it("NTR-P2-007: before-output classification delegates to native with empty selected id when not exposed", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false });
    const replay = buildEnforceFallbackReplayMetadata(snapshot, "delegate_backend_unavailable", classification);

    expect(replay.mode).toBe("delegate_backend_unavailable");
    expect(replay.primaryRuntimeId).toBe("acpx");
    expect(replay.fallbackRuntimeIds).toEqual(["acpx", "codex-native"]);
    expect(replay.fallbackAttempted).toBe(true);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("backend_unavailable_delegated_selected_runtime_not_exposed");
  });

  it("NTR-P2-007: explicit exposed fallback runtime id is recorded without guessing", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false });
    const replay = buildEnforceFallbackReplayMetadata(snapshot, "delegate_backend_unavailable", classification, "codex-native");

    expect(replay.fallbackAttempted).toBe(true);
    expect(replay.fallbackSelectedRuntimeId).toBe("codex-native");
    expect(replay.reason).toBe("backend_unavailable_delegated_to_native");
  });

  it("NTR-P2-007: normal dispatch in enforce mode records no_backend_failure_observed", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({});
    const replay = buildEnforceFallbackReplayMetadata(snapshot, "delegate_backend_unavailable", classification);

    expect(replay.mode).toBe("delegate_backend_unavailable");
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("no_backend_failure_observed");
  });

  it("NTR-P2-007: enforce mode keeps octoclaw recovery for task_timeout with explicit reason", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ timedOut: true });
    const replay = buildEnforceFallbackReplayMetadata(snapshot, "delegate_backend_unavailable", classification);

    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("octoclaw_recovery_owned:task_timeout");
  });

  it("NTR-P2-009: output-started primary failure is not rerouted to native in enforce mode", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true });
    const replay = buildEnforceFallbackReplayMetadata(snapshot, "delegate_backend_unavailable", classification);

    expect(classification.nativeFallbackEligible).toBe(false);
    expect(classification.octoclawRecoveryOwner).toBe(true);
    expect(shouldDelegateBackendUnavailableToNative({ mode: "delegate_backend_unavailable", classification })).toBe(false);
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.reason).toBe("octoclaw_recovery_owned:backend_unavailable_after_output");
  });
});
