import { describe, expect, it } from "vitest";
import {
  classifyNativeAcpFallback,
  loadNativeAcpFallbackSnapshot,
  nativeAcpFallbackMetadata,
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

    expect(nativeAcpFallbackMetadata(snapshot)).toMatchObject({
      owner: "openclaw_acp",
      primaryRuntimeId: "acpx",
      fallbackRuntimeIds: ["acpx", "codex-native"],
      fallbackAttempted: false,
      fallbackSelectedRuntimeId: "",
      reason: "host_runtime_owns_backend_failover",
    });
  });

  it("does not expose an OctoClaw native ACP fallback mode switch", async () => {
    const module = await import("./native-acp-fallback.js");

    expect(["resolve", "Native", "Acp", "Fallback", "Mode"].join("") in module).toBe(false);
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

  it("records host-owned metadata for backend unavailable before output", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classified = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false });

    expect(classified).toMatchObject({
      reason: "backend_unavailable_before_output",
      nativeFallbackEligible: true,
    });
    expect(nativeAcpFallbackMetadata(snapshot)).toMatchObject({
      owner: "openclaw_acp",
      fallbackAttempted: false,
      reason: "host_runtime_owns_backend_failover",
    });
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
    expect(nativeAcpFallbackMetadata(loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx"] } }))).toMatchObject({
      owner: "openclaw_acp",
      fallbackAttempted: false,
    });
  });

  it("non-before-output reasons stay OctoClaw recovery owned", () => {
    const afterOutput = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true });
    const timeout = classifyNativeAcpFallback({ timedOut: true });
    const badResult = classifyNativeAcpFallback({ badResult: true });
    const policyViolation = classifyNativeAcpFallback({ policyViolation: true });
    const none = classifyNativeAcpFallback({});

    expect(afterOutput.octoclawRecoveryOwner).toBe(true);
    expect(timeout.octoclawRecoveryOwner).toBe(true);
    expect(badResult.octoclawRecoveryOwner).toBe(true);
    expect(policyViolation.octoclawRecoveryOwner).toBe(true);
    expect(none.octoclawRecoveryOwner).toBe(true);
  });

  it("P6-007: before-output fallback metadata is host-owned and does not claim an attempt", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: false });
    const replay = nativeAcpFallbackMetadata(snapshot);

    expect(classification.nativeFallbackEligible).toBe(true);
    expect(replay.owner).toBe("openclaw_acp");
    expect(replay.primaryRuntimeId).toBe("acpx");
    expect(replay.fallbackRuntimeIds).toEqual(["acpx", "codex-native"]);
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("host_runtime_owns_backend_failover");
  });

  it("P6-007: host-owned metadata never guesses a selected fallback runtime id", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const replay = nativeAcpFallbackMetadata(snapshot);

    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("host_runtime_owns_backend_failover");
  });

  it("P6-007: normal dispatch records host-owned fallback observation", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({});
    const replay = nativeAcpFallbackMetadata(snapshot);

    expect(classification.reason).toBe("none");
    expect(replay.owner).toBe("openclaw_acp");
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("host_runtime_owns_backend_failover");
  });

  it("P6-008: task_timeout stays OctoClaw recovery owned", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ timedOut: true });
    const replay = nativeAcpFallbackMetadata(snapshot);

    expect(classification.octoclawRecoveryOwner).toBe(true);
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.fallbackSelectedRuntimeId).toBe("");
    expect(replay.reason).toBe("host_runtime_owns_backend_failover");
  });

  it("P6-008: output-started primary failure is not claimed as an OctoClaw native fallback attempt", () => {
    const snapshot = loadNativeAcpFallbackSnapshot({ acp: { fallbacks: ["acpx", "codex-native"] } });
    const classification = classifyNativeAcpFallback({ backendUnavailable: true, outputStarted: true });
    const replay = nativeAcpFallbackMetadata(snapshot);

    expect(classification.nativeFallbackEligible).toBe(false);
    expect(classification.octoclawRecoveryOwner).toBe(true);
    expect(replay.fallbackAttempted).toBe(false);
    expect(replay.reason).toBe("host_runtime_owns_backend_failover");
  });
});
