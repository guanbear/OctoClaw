import { describe, expect, it } from "vitest";
import {
  deliveryRelayVerdict,
  resolveDeliveryRelayMode,
  shouldSendRelayCompensation,
} from "./delivery-relay-verdict.js";

describe("delivery relay verdict", () => {
  it("uses native delivery success as audit-only truth", () => {
    expect(deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469" },
    })).toMatchObject({
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      duplicateRisk: false,
      source: "native_delivery",
      reason: "native_delivery_success",
    });
  });

  it("compensates native delivery failures", () => {
    expect(deliveryRelayVerdict({
      nativeDelivery: { status: "failed", error: "channel_not_found" },
    })).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      source: "native_delivery",
      reason: "native_delivery_failed:channel_not_found",
    });
  });

  it("compensates missing native delivery after timeout when a native result exists", () => {
    expect(deliveryRelayVerdict({
      nativeResultExists: true,
      nativeDeliveryTimedOut: true,
    })).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      source: "none",
      reason: "native_delivery_missing_after_timeout",
    });
  });

  it("skips compensation in audit-only mode when native delivery is proven", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469" },
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
    expect(shouldSendRelayCompensation({ mode: "compensate", verdict })).toBe(false);
  });

  it("allows fallback delivery when native delivery is degraded", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "degraded", error: "native_status_uncertain" },
    });

    expect(verdict).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      reason: "native_delivery_degraded:native_status_uncertain",
    });
    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(true);
  });

  it("suppresses duplicate relay sends", () => {
    expect(deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469", resultHash: "abc" },
      relayResultHash: "abc",
    })).toMatchObject({
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      duplicateRisk: true,
      reason: "duplicate_final_suppressed",
    });
  });

  it("defaults delivery relay mode to native success audit-only", () => {
    expect(resolveDeliveryRelayMode({})).toBe("native_success_audit_only");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "native_success_audit_only" })).toBe("native_success_audit_only");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "compensate" })).toBe("compensate");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "delete_relay" })).toBe("compensate");
  });
});
