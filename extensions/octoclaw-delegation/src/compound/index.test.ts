import { describe, expect, it } from "vitest";
import { buildCompoundDelegationPlaceholder } from "./index.js";
import * as topLevelApi from "../index.js";

describe("compound delegation placeholder", () => {
  it("is not callable from the live top-level path", () => {
    expect("buildCompoundDelegationPlaceholder" in topLevelApi).toBe(true);
    expect(typeof topLevelApi.buildCompoundDelegationPlaceholder).toBe("function");
  });

  it("returns a valid placeholder with schema version", () => {
    expect(buildCompoundDelegationPlaceholder()).toEqual({
      schemaVersion: "octoclaw.delegation.compound/v1",
      availableInPhase1: false,
      reason: "ws4_compound_placeholder",
    });
  });
});
