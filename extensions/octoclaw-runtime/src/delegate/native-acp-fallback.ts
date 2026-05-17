import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";

export type NativeAcpFallbackMode = "observe" | "delegate_backend_unavailable";
export type NativeAcpFallbackReason =
  | "backend_unavailable_before_output"
  | "backend_unavailable_after_output"
  | "task_timeout"
  | "bad_result"
  | "policy_violation"
  | "none";

export interface NativeAcpFallbackSnapshot {
  status: "ok" | "unavailable" | "not_configured";
  primaryRuntimeId: string;
  fallbackRuntimeIds: string[];
  source: "openclaw_config" | "openclaw_status" | "none";
  observedAt: string;
  reason?: string;
}

export interface NativeAcpFallbackClassification {
  reason: NativeAcpFallbackReason;
  nativeFallbackEligible: boolean;
  octoclawRecoveryOwner: boolean;
}

export interface NativeAcpFallbackReplayMetadata {
  mode: NativeAcpFallbackMode;
  primaryRuntimeId: string;
  fallbackRuntimeIds: string[];
  fallbackAttempted: boolean;
  fallbackSelectedRuntimeId: string;
  reason: string;
}

export function resolveNativeAcpFallbackMode(env: Record<string, string | undefined> = process.env): NativeAcpFallbackMode {
  const value = String(env.OCTOCLAW_NATIVE_ACP_FALLBACK_MODE ?? "").trim().toLowerCase();
  if (value === "delegate_backend_unavailable") return "delegate_backend_unavailable";
  return "observe";
}

export function loadNativeAcpFallbackSnapshot(openclawConfig: unknown, now = new Date()): NativeAcpFallbackSnapshot {
  const acp = asRecord(asRecord(openclawConfig).acp);
  const fallbacks = Array.isArray(acp.fallbacks)
    ? acp.fallbacks.map((item) => asString(item)).filter(Boolean)
    : [];
  if (fallbacks.length === 0) {
    return {
      status: Object.keys(acp).length > 0 ? "not_configured" : "unavailable",
      primaryRuntimeId: "",
      fallbackRuntimeIds: [],
      source: "none",
      observedAt: now.toISOString(),
      reason: "native_acp_fallback_unavailable",
    };
  }
  return {
    status: "ok",
    primaryRuntimeId: fallbacks[0] ?? "",
    fallbackRuntimeIds: [...fallbacks],
    source: "openclaw_config",
    observedAt: now.toISOString(),
  };
}

export function readNativeAcpFallbackSnapshot(input: {
  openclawHome?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
} = {}): NativeAcpFallbackSnapshot {
  const env = input.env ?? process.env;
  const openclawHome = asString(input.openclawHome || env.OPENCLAW_HOME) || path.join(os.homedir(), ".openclaw");
  const observedAt = input.now ?? new Date();
  try {
    const raw = fsSync.readFileSync(path.join(openclawHome, "openclaw.json"), "utf8");
    return loadNativeAcpFallbackSnapshot(JSON.parse(raw) as unknown, observedAt);
  } catch (error) {
    return {
      status: "unavailable",
      primaryRuntimeId: "",
      fallbackRuntimeIds: [],
      source: "none",
      observedAt: observedAt.toISOString(),
      reason: `native_acp_fallback_config_read_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function nativeAcpFallbackMetadata(
  snapshot: NativeAcpFallbackSnapshot,
  mode: NativeAcpFallbackMode = resolveNativeAcpFallbackMode(),
  selectedRuntimeId = "",
  reason = "",
): NativeAcpFallbackReplayMetadata {
  return {
    mode,
    primaryRuntimeId: snapshot.primaryRuntimeId,
    fallbackRuntimeIds: [...snapshot.fallbackRuntimeIds],
    fallbackAttempted: Boolean(selectedRuntimeId),
    fallbackSelectedRuntimeId: selectedRuntimeId,
    reason,
  };
}

export function classifyNativeAcpFallback(input: {
  backendUnavailable?: boolean;
  outputStarted?: boolean;
  timedOut?: boolean;
  badResult?: boolean;
  policyViolation?: boolean;
}): NativeAcpFallbackClassification {
  if (input.timedOut) return { reason: "task_timeout", nativeFallbackEligible: false, octoclawRecoveryOwner: true };
  if (input.badResult) return { reason: "bad_result", nativeFallbackEligible: false, octoclawRecoveryOwner: true };
  if (input.policyViolation) return { reason: "policy_violation", nativeFallbackEligible: false, octoclawRecoveryOwner: true };
  if (input.backendUnavailable && input.outputStarted) {
    return { reason: "backend_unavailable_after_output", nativeFallbackEligible: false, octoclawRecoveryOwner: true };
  }
  if (input.backendUnavailable) {
    return { reason: "backend_unavailable_before_output", nativeFallbackEligible: true, octoclawRecoveryOwner: false };
  }
  return { reason: "none", nativeFallbackEligible: false, octoclawRecoveryOwner: true };
}

export function shouldDelegateBackendUnavailableToNative(input: {
  mode: NativeAcpFallbackMode;
  classification: NativeAcpFallbackClassification;
}): boolean {
  return input.mode === "delegate_backend_unavailable"
    && input.classification.reason === "backend_unavailable_before_output"
    && input.classification.nativeFallbackEligible;
}

export function nativeAcpFallbackSnapshotFromStatus(status: UnknownRecord, now = new Date()): NativeAcpFallbackSnapshot {
  return loadNativeAcpFallbackSnapshot({ acp: { fallbacks: status.fallbacks } }, now);
}
