import { describe, expect, it } from "vitest";
import {
  deliveryRelayVerdict,
  resolveDeliveryRelayMode,
  shouldSendRelayCompensation,
} from "./delivery-relay-verdict.js";

describe("delivery relay verdict", () => {
  // BDD: NTR-P3-001
  it("NTR-P3-001: native delivery success creates audit-only verdict", () => {
    expect(deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469" },
    })).toMatchObject({
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      relayCompensationRan: false,
      relayCompensationReason: "native_delivered_no_compensation_needed",
      duplicateRisk: false,
      source: "native_delivery",
      reason: "native_delivery_success",
    });
  });

  // BDD: NTR-P3-002
  it("NTR-P3-002: native delivery failure still compensates", () => {
    expect(deliveryRelayVerdict({
      nativeDelivery: { status: "failed", error: "channel_not_found" },
    })).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: "compensation_needed:native_delivery_failed:channel_not_found",
      source: "native_delivery",
      reason: "native_delivery_failed:channel_not_found",
    });
  });

  // BDD: NTR-P3-003
  it("NTR-P3-003: native delivery missing with native result compensates after timeout", () => {
    expect(deliveryRelayVerdict({
      nativeResultExists: true,
      nativeDeliveryTimedOut: true,
    })).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: "compensation_needed:native_delivery_missing_after_timeout",
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

  // BDD: NTR-P3-008
  it("NTR-P3-008: duplicate native final suppresses relay and records audit", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469", resultHash: "abc" },
      relayResultHash: "abc",
    });

    expect(verdict).toMatchObject({
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      relayCompensationRan: false,
      relayCompensationReason: "duplicate_no_compensation_needed",
      duplicateRisk: true,
      reason: "duplicate_final_suppressed",
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
    expect(shouldSendRelayCompensation({ mode: "compensate", verdict })).toBe(false);
  });

  it("defaults delivery relay mode to native success audit-only", () => {
    expect(resolveDeliveryRelayMode({})).toBe("native_success_audit_only");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "native_success_audit_only" })).toBe("native_success_audit_only");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "compensate" })).toBe("compensate");
    expect(resolveDeliveryRelayMode({ OCTOCLAW_DELIVERY_RELAY_MODE: "delete_relay" })).toBe("compensate");
  });

  // BDD: NTR-P3-004
  it("NTR-P3-004: native success audit-only mode does not resend", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469" },
    });

    expect(verdict).toMatchObject({
      finalVisible: true,
      nativeDelivered: true,
      relayCompensationNeeded: false,
      relayCompensationRan: false,
      relayCompensationReason: "native_delivered_no_compensation_needed",
      duplicateRisk: false,
      source: "native_delivery",
      reason: "native_delivery_success",
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
    expect(shouldSendRelayCompensation({ mode: "compensate", verdict })).toBe(false);
  });

  // BDD: NTR-P3-005
  it("NTR-P3-005: message-tool-only reply not compensated when native visible", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032469" },
      presentation: "message_tool",
    });

    expect(verdict).toMatchObject({
      nativeDelivered: true,
      relayCompensationReason: "native_delivered_no_compensation_needed",
      reason: "native_delivery_success",
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
  });

  // BDD: NTR-P3-006
  it("NTR-P3-006: card/button-only reply not compensated, audit records rich native delivery success", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "delivered", messageId: "1778573724.032470" },
      presentation: "rich",
    });

    expect(verdict).toMatchObject({
      nativeDelivered: true,
      relayCompensationNeeded: false,
      relayCompensationRan: false,
      relayCompensationReason: "rich_native_delivered_no_compensation_needed",
      duplicateRisk: false,
      source: "native_delivery",
      reason: "rich_native_delivery_success",
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
  });

  // BDD: NTR-P3-007
  it("NTR-P3-007: native degraded still allows fallback compensation", () => {
    const verdict = deliveryRelayVerdict({
      nativeDelivery: { status: "degraded", error: "native_status_uncertain" },
    });

    expect(verdict).toMatchObject({
      nativeDelivered: false,
      relayCompensationNeeded: true,
      relayCompensationRan: false,
      relayCompensationReason: "compensation_needed:native_delivery_degraded:native_status_uncertain",
      reason: "native_delivery_degraded:native_status_uncertain",
    });

    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(true);
    expect(shouldSendRelayCompensation({ mode: "compensate", verdict })).toBe(true);
  });

  it("unconfirmed native delivery (sent/acknowledged/acked) is not treated as delivered", () => {
    for (const unconfirmedStatus of ["sent", "acknowledged", "acked"] as const) {
      const verdict = deliveryRelayVerdict({
        nativeDelivery: { status: unconfirmedStatus },
      });

      expect(verdict).toMatchObject({
        finalVisible: false,
        nativeDelivered: false,
        relayCompensationNeeded: false,
        duplicateRisk: false,
        source: "native_delivery",
      });
      expect(verdict.reason).toBe(`native_delivery_unconfirmed:${unconfirmedStatus}`);

      expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(false);
      expect(shouldSendRelayCompensation({ mode: "compensate", verdict })).toBe(false);
    }
  });

  // BDD: NTR-P3-009
  it("NTR-P3-009: mock coverage matrix for native delivery trust", () => {
    const matrix = [
      { nativeDelivery: { status: "delivered", messageId: "m1" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: true, expectCompensation: false },
      { nativeDelivery: { status: "delivered", messageId: "m2" } as Record<string, string>, presentation: "message_tool", expectNativeDelivered: true, expectCompensation: false },
      { nativeDelivery: { status: "delivered", messageId: "m3" } as Record<string, string>, presentation: "rich", expectNativeDelivered: true, expectCompensation: false },
      { nativeDelivery: { status: "delivered", messageId: "m4", resultHash: "h" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: true, expectCompensation: false, relayResultHash: "h", expectDuplicate: true },
      { nativeDelivery: { status: "sent" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: false },
      { nativeDelivery: { status: "acknowledged" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: false },
      { nativeDelivery: { status: "failed", error: "channel_not_found" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: true },
      { nativeDelivery: { status: "error", error: "timeout" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: true },
      { nativeDelivery: { status: "degraded", error: "uncertain" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: true },
      { nativeDelivery: { status: "unknown" } as Record<string, string>, presentation: undefined as string | undefined, expectNativeDelivered: false, expectCompensation: true },
    ] as const;

    for (const row of matrix) {
      const verdict = deliveryRelayVerdict({
        nativeDelivery: row.nativeDelivery,
        presentation: row.presentation as "plain" | "message_tool" | "rich" | undefined,
        relayResultHash: "relayResultHash" in row ? (row as { relayResultHash?: string }).relayResultHash : undefined,
      });

      expect(verdict.nativeDelivered).toBe(row.expectNativeDelivered);
      if ("expectDuplicate" in row && (row as { expectDuplicate?: boolean }).expectDuplicate) {
        expect(verdict.duplicateRisk).toBe(true);
        expect(verdict.reason).toBe("duplicate_final_suppressed");
      }
      expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(row.expectCompensation);
    }
  });

  it("NTR-P3-009: missing after timeout still compensates", () => {
    const verdict = deliveryRelayVerdict({
      nativeResultExists: true,
      nativeDeliveryTimedOut: true,
    });

    expect(verdict.nativeDelivered).toBe(false);
    expect(verdict.relayCompensationNeeded).toBe(true);
    expect(shouldSendRelayCompensation({ mode: "native_success_audit_only", verdict })).toBe(true);
  });
});
