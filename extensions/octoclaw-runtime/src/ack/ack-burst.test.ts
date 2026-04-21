import { describe, expect, it, beforeEach } from "vitest";
import {
  shouldSuppressAck,
  recordMessage,
  resetBurstState,
  type AckGateState,
} from "./ack-burst.js";

describe("ack-burst: shouldSuppressAck with AckGateState", () => {
  const threadKey = "slack:channel:C123:thread_T456";

  beforeEach(() => {
    resetBurstState();
  });

  describe("spec suppress: delivered / final_response_streaming / delivery_pending / formal_reply_visible", () => {
    it("suppresses when gate.delivered is true", () => {
      const gate: AckGateState = { delivered: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("delivered");
    });

    it("suppresses when gate.final_response_streaming is true", () => {
      const gate: AckGateState = { final_response_streaming: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("final_response_streaming");
    });

    it("suppresses when gate.delivery_pending is true", () => {
      const gate: AckGateState = { delivery_pending: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("delivery_pending");
    });

    it("suppresses when gate.formal_reply_visible is true", () => {
      const gate: AckGateState = { formal_reply_visible: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("formal_reply_visible");
    });

    it("delivered takes priority over tool_active", () => {
      const gate: AckGateState = { delivered: true, tool_active: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("delivered");
    });

    it("final_response_streaming takes priority over delegated_running", () => {
      const gate: AckGateState = { final_response_streaming: true, delegated_running: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "delegate", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("final_response_streaming");
    });
  });

  describe("spec eligible: tool_active / blocked (after silence window)", () => {
    it("allows ACK when tool_active is true and silence window passed", () => {
      recordMessage(threadKey, Date.now() - 10_000);
      const gate: AckGateState = { tool_active: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(false);
      expect(result.reason).toBe("allow");
    });

    it("allows ACK when blocked is true and silence window passed", () => {
      recordMessage(threadKey, Date.now() - 10_000);
      const gate: AckGateState = { blocked: true };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(false);
      expect(result.reason).toBe("allow");
    });

    it("suppresses delegated_running without tool_active/blocked", () => {
      recordMessage(threadKey, Date.now() - 10_000);
      const gate: AckGateState = { delegated_running: true, tool_active: false, blocked: false };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("not_ack_eligible_no_active_work");
    });
  });

  describe("spec suppress: no active work when gate has values (after silence window)", () => {
    it("suppresses when gate has all false flags", () => {
      recordMessage(threadKey, Date.now() - 10_000);
      const gate: AckGateState = {
        tool_active: false,
        blocked: false,
      };
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {}, gate);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("not_ack_eligible_no_active_work");
    });
  });

  describe("backward compat: no gate state passed", () => {
    it("falls back to legacy behavior when no gate provided", () => {
      recordMessage(threadKey);
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {});
      expect(typeof result.suppressed).toBe("boolean");
      expect(typeof result.reason).toBe("string");
    });

    it("mainModelStartedOutput still suppresses", () => {
      recordMessage(threadKey);
      const result = shouldSuppressAck(threadKey, "tool_still_working", "reply", {
        mainModelStartedOutput: true,
      });
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("main_model_started_output");
    });
  });
});
