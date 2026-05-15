import { describe, expect, it, vi } from "vitest";

vi.mock("./resolve/env.js", () => ({
  resolveWorkspaceRoot: () => "/tmp/octoclaw-test-workspace",
  runCommand: async () => ({
    code: 0,
    stdout: JSON.stringify({
      models: [
        { key: "cliproxyapi/gpt-5.5", available: true, local: true, tags: ["default", "configured"] },
        { key: "zhipu/GLM-5.1", available: true, tags: ["fallback#1", "configured"] },
        { key: "zai/glm-4.7", available: true, tags: ["fallback#2", "configured"] },
      ],
    }),
    stderr: "",
  }),
}));

import { buildModelMap } from "./model-map.js";

describe("model map", () => {
  it("uses fallback rank before local flag for cheap/simple lanes", async () => {
    await expect(buildModelMap()).resolves.toMatchObject({
      complexity: {
        simple: "zai/glm-4.7",
        normal: "zhipu/GLM-5.1",
        deep: "cliproxyapi/gpt-5.5",
      },
      budget: {
        low: "zai/glm-4.7",
        medium: "zhipu/GLM-5.1",
        high: "cliproxyapi/gpt-5.5",
      },
    });
  });
});
