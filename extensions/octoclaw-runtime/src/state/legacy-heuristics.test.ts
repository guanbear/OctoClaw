import { describe, expect, it } from "vitest";
import {
  buildLegacyHeuristicFallbackEvent,
  legacyHeuristicVerdict,
  resolveLegacyHeuristicMode,
} from "./legacy-heuristics.js";

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
