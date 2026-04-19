import { describe, expect, it } from "vitest";
import {
  resolveDelegationProfile,
  selectDelegationBackend,
  worker_code,
  worker_research,
  worker_review,
} from "./index.js";

describe("delegation profiles", () => {
  it("resolves the code profile", () => {
    expect(resolveDelegationProfile("worker_code")).toEqual(worker_code);
  });

  it("resolves the research profile", () => {
    expect(resolveDelegationProfile("worker_research")).toEqual(worker_research);
  });

  it("resolves the review profile", () => {
    expect(resolveDelegationProfile("worker_review")).toEqual(worker_review);
  });

  it("rejects non-delegation roles", () => {
    expect(() => resolveDelegationProfile("main_reply")).toThrowError("unsupported_delegation_role:main_reply");
  });

  it("defaults backend selection to openclaw-native", () => {
    const selection = selectDelegationBackend("worker_code");

    expect(selection.backend).toBe("openclaw-native");
    expect(selection.profile).toEqual(worker_code);
  });

  it("maps each delegation role to the expected model profile", () => {
    expect(resolveDelegationProfile("worker_code").modelProfile).toBe("worker_code_normal");
    expect(resolveDelegationProfile("worker_research").modelProfile).toBe("worker_research");
    expect(resolveDelegationProfile("worker_review").modelProfile).toBe("worker_review");
  });
});
