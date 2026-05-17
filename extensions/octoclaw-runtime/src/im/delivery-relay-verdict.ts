import { asString, isRecord } from "../util/type-coercion.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { buildLegacyHeuristicFallbackEvent, legacyHeuristicVerdict } from "../state/legacy-heuristics.js";

export type DeliveryRelayMode = "compensate" | "native_success_audit_only";
export type DeliveryTruthSource = "native_delivery" | "octoclaw_relay" | "audit_only" | "none";

export interface DeliveryRelayVerdict {
  finalVisible: boolean;
  nativeDelivered: boolean;
  relayCompensationNeeded: boolean;
  relayCompensationRan: boolean;
  relayCompensationReason: string;
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

export type DeliveryPresentation = "plain" | "message_tool" | "rich";

export function deliveryRelayVerdict(input: {
  nativeDelivery?: unknown;
  nativeResultExists?: boolean;
  nativeDeliveryTimedOut?: boolean;
  relayResultHash?: string;
  presentation?: DeliveryPresentation;
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
    const isRich = input.presentation === "rich";
    const successReason = duplicateRisk ? "duplicate_final_suppressed" : isRich ? "rich_native_delivery_success" : "native_delivery_success";
    const compensationReason = duplicateRisk ? "duplicate_no_compensation_needed" : isRich ? "rich_native_delivered_no_compensation_needed" : "native_delivered_no_compensation_needed";
    return {
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      relayCompensationRan: false,
      relayCompensationReason: compensationReason,
      duplicateRisk,
      source: "native_delivery",
      reason: successReason,
    };
  }

  if (["failed", "error"].includes(status)) {
    if (!nativeDeliveryStructured) {
      recordDeliveryProjectionLegacyBoundary("delivery_status_string_match");
    }
    const failureDetail = error || status;
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: `compensation_needed:native_delivery_failed:${failureDetail}`,
      duplicateRisk: false,
      source: "native_delivery",
      reason: `native_delivery_failed:${failureDetail}`,
    };
  }

  if (["degraded", "unknown"].includes(status)) {
    if (!nativeDeliveryStructured) {
      recordDeliveryProjectionLegacyBoundary("delivery_status_string_match");
    }
    const degradedDetail = error || status;
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: `compensation_needed:native_delivery_degraded:${degradedDetail}`,
      duplicateRisk: false,
      source: "native_delivery",
      reason: `native_delivery_degraded:${degradedDetail}`,
    };
  }

  if (input.nativeResultExists && input.nativeDeliveryTimedOut) {
    return {
      finalVisible: false,
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: "compensation_needed:native_delivery_missing_after_timeout",
      duplicateRisk: false,
      source: "none",
      reason: "native_delivery_missing_after_timeout",
    };
  }

  return {
    finalVisible: false,
    nativeDelivered: false,
    relayCompensationNeeded: false,
    relayCompensationRan: false,
    relayCompensationReason: "no_native_delivery_data",
    duplicateRisk: false,
    source: "none",
    reason: "native_delivery_pending",
  };
}

export function shouldSendRelayCompensation(input: {
  mode: DeliveryRelayMode;
  verdict: DeliveryRelayVerdict;
}): boolean {
  const { mode, verdict } = input;

  if (verdict.duplicateRisk) return false;

  if (mode === "native_success_audit_only" && verdict.nativeDelivered) return false;

  return verdict.relayCompensationNeeded && !verdict.nativeDelivered;
}
