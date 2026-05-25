import { describe, expect, it } from "vitest";
import { classifyStartupCost } from "./policy-routing-helpers.js";

describe("NFSV2 default startup cost policy", () => {
  it("treats route_hint=delegate as advisory budgeted-main, not hard delegation", () => {
    const classification = classifyStartupCost("查一下最新 release 变化", {
      route_hint: "delegate",
    });

    expect(classification.decisionBucket).toBe("budgeted_main_then_delegate");
    expect(classification.hardDelegateSignal).toBe(false);
    expect(classification.reasonCodes).toContain("route_hint_delegate_advisory_only");
  });

  it("makes wall-time handling explicit as observe-only by default", () => {
    const classification = classifyStartupCost("查一下最新 release 变化", {
      intent_packet: { require_fresh_lookup: true },
    });

    expect(classification.startupCostPolicy).toMatchObject({
      decision_bucket: "budgeted_main_then_delegate",
      wall_time_mode: "observe_only",
      automatic_retry_automation: false,
      route_hint_hard_precondition: false,
    });
  });
});
