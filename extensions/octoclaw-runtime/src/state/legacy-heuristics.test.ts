import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildLegacyHeuristicFallbackEvent,
  legacyHeuristicVerdict,
  type LegacyHeuristicSurface,
  resolveLegacyHeuristicMode,
} from "./legacy-heuristics.js";
import { isSubagentSessionRef } from "../resolve/session.js";

describe("legacy heuristic isolation", () => {
  it("marks old-record status fallback as read-only and allowed only for display", () => {
    const verdict = legacyHeuristicVerdict({
      surface: "status_projection",
      hasNativeTruth: false,
      hasKnownNativeId: false,
      hasLegacySignal: true,
      newTask: false,
      reason: "native_fields_absent",
    });

    expect(verdict).toEqual({
      allowed: true,
      readOnly: true,
      reason: "native_fields_absent",
      source: "legacy_heuristic_read_only",
    });
  });

  it("blocks legacy fallback for new dispatch admission", () => {
    const verdict = legacyHeuristicVerdict({
      surface: "dispatch_guard",
      hasNativeTruth: false,
      hasKnownNativeId: false,
      hasLegacySignal: true,
      newTask: true,
      reason: "no_native_spawn_evidence",
    });

    expect(verdict).toEqual({
      allowed: false,
      readOnly: true,
      reason: "no_native_spawn_evidence",
      source: "legacy_heuristic_read_only",
    });
  });

  it("emits countable fallback event payloads", () => {
    expect(buildLegacyHeuristicFallbackEvent({
      taskId: "task-1",
      workContractId: "wc-1",
      surface: "status_projection",
      reason: "native_fields_absent",
      newTask: true,
      allowed: false,
    })).toEqual({
      event: "legacy_heuristic_fallback_used",
      taskId: "task-1",
      workContractId: "wc-1",
      surface: "status_projection",
      reason: "native_fields_absent",
      newTask: true,
      readOnly: true,
      allowed: false,
    });
  });

  it("defaults legacy heuristic mode to read_only", () => {
    expect(resolveLegacyHeuristicMode({})).toBe("read_only");
    expect(resolveLegacyHeuristicMode({ OCTOCLAW_LEGACY_HEURISTIC_MODE: "off" })).toBe("off");
    expect(resolveLegacyHeuristicMode({ OCTOCLAW_LEGACY_HEURISTIC_MODE: "enforce" })).toBe("read_only");
  });
});

describe("NTR-P1-005: legacy heuristic blocks for new tasks at dispatch_guard", () => {
  it("does not allow legacy fallback for new tasks at dispatch_guard surface", () => {
    const verdict = legacyHeuristicVerdict({
      surface: "dispatch_guard",
      hasNativeTruth: false,
      hasKnownNativeId: false,
      hasLegacySignal: true,
      newTask: true,
      reason: "no_native_spawn_evidence",
    });
    expect(verdict.allowed).toBe(false);
  });
});

describe("NTR-P1-006: legacy heuristic allows read-only for old tasks at status_projection", () => {
  it("allows legacy fallback for old tasks at status_projection surface", () => {
    const verdict = legacyHeuristicVerdict({
      surface: "status_projection",
      hasNativeTruth: false,
      hasKnownNativeId: false,
      hasLegacySignal: true,
      newTask: false,
      reason: "native_fields_absent",
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.readOnly).toBe(true);
  });
});

describe("NTR-P1-007: legacy_heuristic_fallback_used event fires with correct fields", () => {
  it("emits event with all required fields at every surface", () => {
    const surfaces: LegacyHeuristicSurface[] = ["status_projection", "dispatch_guard", "message_guard", "delivery_projection", "result_projection"];
    for (const surface of surfaces) {
      const event = buildLegacyHeuristicFallbackEvent({
        taskId: "task-1",
        workContractId: "wc-1",
        surface,
        reason: "test_reason",
        newTask: false,
        allowed: true,
      });
      expect(event).toMatchObject({
        event: "legacy_heuristic_fallback_used",
        surface,
        reason: "test_reason",
        newTask: false,
        readOnly: true,
        allowed: true,
      });
    }
  });
});

describe("NTR-P1-008: hot-path modules do not import legacy-heuristic functions", () => {
  it("verifies dispatch/spawn/confirm/ACK/delivery modules are clean", () => {
    const hotPaths = [
      "extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts",
      "extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts",
      "extensions/octoclaw-runtime/src/ack/ack-guard.ts",
      "extensions/octoclaw-runtime/src/ack/ack-decision.ts",
      "extensions/octoclaw-runtime/src/tools/handlers/dispatch.ts",
      "extensions/octoclaw-runtime/src/resolve/native-announce-delivery.ts",
    ];
    for (const filePath of hotPaths) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).not.toContain("legacyHeuristicVerdict");
      expect(content).not.toContain("legacy_heuristic_fallback_used");
      expect(content).not.toContain("legacy-heuristics");
    }
  });
});

describe("NTR-P1-009: native spawn-child kind wins over session key content", () => {
  it("returns true for spawn-child even when the key has no subagent marker", () => {
    expect(isSubagentSessionRef("agent:worker:plain-session", "spawn-child")).toBe(true);
  });
});

describe("NTR-P1-010: native direct kind wins over legacy subagent markers", () => {
  it("returns false for direct even when the key contains subagent", () => {
    expect(isSubagentSessionRef("octoclaw-subagent-legacy", "direct")).toBe(false);
  });
});
