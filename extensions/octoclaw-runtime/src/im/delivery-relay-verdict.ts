import { asString, isRecord } from "../util/type-coercion.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { buildLegacyHeuristicFallbackEvent, legacyHeuristicVerdict } from "../state/legacy-heuristics.js";

export type DeliveryRelayMode = "compensate" | "native_success_audit_only";
export type DeliveryTruthSource = "native_delivery" | "octoclaw_relay" | "audit_only" | "none";

export interface DeliveryRelayVerdict {
  finalVisible: boolean;
  nativeDelivered: boolean;
  relayCompensationNeeded: boolean;
  duplicateRisk: boolean;
  source: DeliveryTruthSource;
  reason: string;
}

export function resolveDeliveryRelayMode(env: Record<string, string | undefined> = process.env): DeliveryRelayMode {
  const value = String(env.OCTOCLAW_DELIVERY_RELAY_MODE ?? "").trim().toLowerCase();
  if (value === "compensate") return "compensate";
  return value === "delete_relay" ? "compensate" : "native_success_audit_only";
}

function nativeDeliveryStatus(nativeDelivery: unknown): string {
  return isRecord(nativeDelivery) ? asString(nativeDelivery.status || nativeDelivery.deliveryStatus).toLowerCase() : "";
}

function nativeDeliveryError(nativeDelivery: unknown): string {
  return isRecord(nativeDelivery) ? asString(nativeDelivery.error || nativeDelivery.reason || nativeDelivery.code) : "";
}

function nativeDeliveryResultHash(nativeDelivery: unknown): string {
  return isRecord(nativeDelivery) ? asString(nativeDelivery.resultHash || nativeDelivery.result_hash) : "";
}

function recordDeliveryProjectionLegacyBoundary(reason: string): void {
  const verdict = legacyHeuristicVerdict({
    surface: "delivery_projection",
    hasNativeTruth: false,
    hasKnownNativeId: false,
    hasLegacySignal: true,
    newTask: false,
    reason,
  });
  if (verdict.source === "legacy_heuristic_read_only") {
    void recordPolicyReplay("legacy_heuristic_fallback_used", buildLegacyHeuristicFallbackEvent({
      surface: "delivery_projection",
      reason: verdict.reason,
      newTask: false,
      allowed: verdict.allowed,
    })).catch(() => undefined);
  }
}

export function deliveryRelayVerdict(input: {
  nativeDelivery?: unknown;
  nativeResultExists?: boolean;
  nativeDeliveryTimedOut?: boolean;
  relayResultHash?: string;
}): DeliveryRelayVerdict {
  const status = nativeDeliveryStatus(input.nativeDelivery);
  const error = nativeDeliveryError(input.nativeDelivery);
  const resultHash = nativeDeliveryResultHash(input.nativeDelivery);
  const nativeDeliveryStructured = isRecord(input.nativeDelivery) && Boolean(input.nativeDelivery.status || input.nativeDelivery.deliveryStatus);

  if (["delivered", "sent", "acknowledged", "acked"].includes(status)) {
    if (!nativeDeliveryStructured) {
      recordDeliveryProjectionLegacyBoundary("delivery_status_string_match");
    }
    const duplicateRisk = Boolean(resultHash && input.relayResultHash && resultHash === input.relayResultHash);
    return {
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      duplicateRisk,
      source: "native_delivery",
      reason: duplicateRisk ? "duplicate_final_suppressed" : "native_delivery_success",
    };
  }

  if (["failed", "error"].includes(status)) {
    if (!nativeDeliveryStructured) {
      recordDeliveryProjectionLegacyBoundary("delivery_status_string_match");
    }
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      duplicateRisk: false,
      source: "native_delivery",
      reason: `native_delivery_failed:${error || status}`,
    };
  }

  if (["degraded", "unknown"].includes(status)) {
    if (!nativeDeliveryStructured) {
      recordDeliveryProjectionLegacyBoundary("delivery_status_string_match");
    }
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      duplicateRisk: false,
      source: "native_delivery",
      reason: `native_delivery_degraded:${error || status}`,
    };
  }

  if (input.nativeResultExists && input.nativeDeliveryTimedOut) {
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      duplicateRisk: false,
      source: "none",
      reason: "native_delivery_missing_after_timeout",
    };
  }

  return {
    finalVisible: false,
    nativeDelivered: false,
    relayCompensationNeeded: false,
    duplicateRisk: false,
    source: "none",
    reason: "native_delivery_pending",
  };
}

export function shouldSendRelayCompensation(input: {
  mode: DeliveryRelayMode;
  verdict: DeliveryRelayVerdict;
}): boolean {
  void input.mode;
  return input.verdict.relayCompensationNeeded && !input.verdict.nativeDelivered && !input.verdict.duplicateRisk;
}
