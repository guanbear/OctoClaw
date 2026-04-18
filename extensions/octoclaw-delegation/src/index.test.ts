import { describe, expect, it } from "vitest";
import * as publicApi from "./index.js";

describe("delegation public API", () => {
  it("re-exports brief, profiles, and materialize entrypoints", () => {
    expect(publicApi.buildWorkerBrief).toBeTypeOf("function");
    expect(publicApi.resolveDelegationProfile).toBeTypeOf("function");
    expect(publicApi.selectDelegationBackend).toBeTypeOf("function");
    expect(publicApi.materializeDelegatedWork).toBeTypeOf("function");
  });

  it("exposes the current package surface", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "DELEGATION_PROFILES",
      "buildCompoundDelegationPlaceholder",
      "buildWorkerBrief",
      "decideConflictPolicy",
      "materializeDelegatedWork",
      "resolveDelegationProfile",
      "selectDelegationBackend",
      "worker_code",
      "worker_research",
      "worker_review",
    ]);
  });
});
