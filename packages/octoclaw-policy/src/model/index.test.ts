import { describe, expect, it } from "vitest";
import { decideModelProfile, resolveModelId, V1_MODEL_PROFILE_MAP } from "./index.js";

describe("model policy", () => {
  it("maps all 9 profiles correctly", () => {
    expect(V1_MODEL_PROFILE_MAP).toEqual({
      judge_fast: "minimax-portal/MiniMax-M2.7",
      observer_probe: "minimax-portal/MiniMax-M2.7",
      direct_main: "zhipu/GLM-5.1",
      worker_default: "zhipu/GLM-5.1",
      worker_research: "zhipu/GLM-5.1",
      worker_code_normal: "zhipu/GLM-5.1",
      worker_code_deep: "omniroute/cx/gpt-5.4",
      worker_review: "omniroute/cx/gpt-5.4",
      worker_deep: "omniroute/cx/gpt-5.4",
    });
  });

  it("resolves specific model ids", () => {
    expect(resolveModelId("judge_fast")).toBe("minimax-portal/MiniMax-M2.7");
    expect(resolveModelId("worker_code_deep")).toBe("omniroute/cx/gpt-5.4");
    expect(resolveModelId("direct_main")).toBe("zhipu/GLM-5.1");
  });

  it("chooses code profile by workspace mode", () => {
    expect(decideModelProfile("worker_code", "isolated_workspace").modelProfile).toBe("worker_code_normal");
    expect(decideModelProfile("worker_code", "shared_workspace").modelProfile).toBe("worker_code_deep");
  });
});
