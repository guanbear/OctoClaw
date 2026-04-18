import { describe, expect, it } from "vitest";
import { buildIntentPacket } from "./index.js";

describe("intent packet", () => {
  it("uses confidence 1 for explicit intent class", () => {
    expect(buildIntentPacket({ intentClass: "delegated_work" })).toEqual({
      intentClass: "delegated_work",
      confidence: 1,
      evidence: ["explicit_intent_class"],
    });
  });

  it("maps surface bound hints to local surface lookup", () => {
    expect(buildIntentPacket({ surfaceBound: true })).toEqual({
      intentClass: "local_surface_lookup",
      confidence: 0.9,
      evidence: ["surface_bound"],
    });
  });

  it("returns undetermined without hints", () => {
    expect(buildIntentPacket()).toEqual({
      intentClass: "undetermined",
      confidence: 0.3,
      evidence: ["no_structured_intent_signal"],
    });
  });
});
