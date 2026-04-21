import { describe, expect, it } from "vitest";
import {
  resolveAckTargetFromSessionKey,
  resolveRoutePhase,
  threadKeyFromSessionKey as threadKeyFn,
} from "./ack-guard.js";

describe("ack-guard: canonical resolver integration", () => {
  describe("resolveAckTargetFromSessionKey", () => {
    it("extracts target and threadId from Slack channel+thread session key", () => {
      const key = "slack:default:channel:C123ABC:thread:1234567890.123456";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
      expect(target.threadId).toBe("1234567890.123456");
    });

    it("extracts target from Slack DM session key", () => {
      const key = "slack:default:dm:U123ABC";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
    });

    it("extracts target from Slack channel session key without thread", () => {
      const key = "slack:default:channel:C123ABC";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
      expect(target.threadId).toBe("");
    });

    it("returns empty for non-IM session key", () => {
      const key = "agent:main:main";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBe("");
      expect(target.threadId).toBe("");
    });
  });

  describe("resolveRoutePhase", () => {
    it("returns delegate for delegate route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "delegate" } });
      expect(result).toBe("delegate");
    });

    it("returns pre_route for delegate.single route (compound routes not auto-detected)", () => {
      const result = resolveRoutePhase({ route_decision: { route: "delegate.single" } });
      expect(result).toBe("pre_route");
    });

    it("returns reply for reply route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "reply" } });
      expect(result).toBe("reply");
    });

    it("returns reply for direct route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "direct" } });
      expect(result).toBe("reply");
    });

    it("returns observe for observe route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "observe" } });
      expect(result).toBe("observe");
    });

    it("returns pre_route for empty decision", () => {
      const result = resolveRoutePhase({});
      expect(result).toBe("pre_route");
    });

    it("respects explicit routePhase option", () => {
      const result = resolveRoutePhase({}, { routePhase: "delegate" });
      expect(result).toBe("delegate");
    });
  });

  describe("threadKeyFromSessionKey uses canonical threadKey", () => {
    it("produces threadKey with binding and thread for Slack channel+thread", () => {
      const key = "slack:default:channel:C123ABC:thread:1234567890.123456";
      const threadKey = threadKeyFn(key);
      expect(threadKey).toContain("slack");
      expect(threadKey).toContain("1234567890.123456");
    });

    it("falls back to binding key when no threadId", () => {
      const key = "slack:default:channel:C123ABC";
      const threadKey = threadKeyFn(key);
      expect(threadKey).toContain("slack");
    });

    it("falls back to stateKey for non-IM sessions", () => {
      const key = "agent:main:main";
      const threadKey = threadKeyFn(key, "fallback-state-key");
      expect(threadKey).toBe("fallback-state-key");
    });
  });
});
