import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    delete process.env.OCTOCLAW_ROUTER_SNAPSHOT_JSON;
    delete process.env.OCTOCLAW_ROUTER_SNAPSHOT_PATH;
  });

  it("uses fallback rank before local flag for cheap/simple lanes", async () => {
    process.env.OCTOCLAW_ROUTER_SNAPSHOT_PATH = "/tmp/octoclaw-test-workspace/missing-model-intel-snapshot.json";
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

  it("uses model-intel tiers for deep and complex lanes when fallback tags underspecify capability", async () => {
    process.env.OCTOCLAW_ROUTER_SNAPSHOT_JSON = JSON.stringify({
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "test-snapshot",
      generatedAt: "2026-05-22T00:00:00.000Z",
      sourceStatus: [],
      models: [
        modelIntel("cliproxyapi/gpt-5.5", "frontier", 11.25),
        modelIntel("zhipu/GLM-5.1", "strong", 1.505),
        modelIntel("cliproxyapi/gpt-5.4-mini", "mini", 1.6875),
        modelIntel("zai/glm-4.7", "strong", 1),
      ],
    });
    await expect(buildModelMap()).resolves.toMatchObject({
      complexity: {
        simple: "cliproxyapi/gpt-5.4-mini",
        normal: "zhipu/GLM-5.1",
        complex: "zai/glm-4.7",
        deep: "cliproxyapi/gpt-5.5",
      },
    });
  });

  it("uses the router snapshot path used by live runtime when no inline snapshot is provided", async () => {
    const snapshotPath = path.join("/tmp/octoclaw-test-workspace", "model-intel-snapshot.json");
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "test-snapshot-file",
      generatedAt: "2026-05-22T00:00:00.000Z",
      sourceStatus: [],
      models: [
        modelIntel("cliproxyapi/gpt-5.5", "frontier", 11.25),
        modelIntel("zhipu/GLM-5.1", "strong", 1.505),
        modelIntel("cliproxyapi/gpt-5.4-mini", "mini", 1.6875),
      ],
    }));
    process.env.OCTOCLAW_ROUTER_SNAPSHOT_PATH = snapshotPath;

    await expect(buildModelMap()).resolves.toMatchObject({
      complexity: {
        simple: "cliproxyapi/gpt-5.4-mini",
        deep: "cliproxyapi/gpt-5.5",
      },
    });
  });

  it("does not route live work to proposal-only or unconfigured snapshot models", async () => {
    process.env.OCTOCLAW_ROUTER_SNAPSHOT_JSON = JSON.stringify({
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "test-unconfigured",
      generatedAt: "2026-05-22T00:00:00.000Z",
      sourceStatus: [],
      models: [
        { ...modelIntel("openai/gpt-5-mini", "mini", 0.2), configured: false, proposalOnly: true },
        { ...modelIntel("cliproxyapi/gpt-5.4-mini", "mini", 1.6875), configured: true, proposalOnly: false },
      ],
    });

    await expect(buildModelMap()).resolves.toMatchObject({
      complexity: {
        simple: "cliproxyapi/gpt-5.4-mini",
      },
    });
  });
});

function modelIntel(modelKey: string, tier: string, price: number) {
  const [provider, model] = modelKey.split("/");
  return {
    provider,
    model,
    modelKey,
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: [],
    marketPrice: { blendedUsdPerMTok: price, confidence: "high", sources: ["test"] },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: tier,
      confidence: "high",
      evidence: ["declared"],
      sources: ["test"],
    },
    health: { available: "yes", cooldown: false, quotaPressure: "low", sources: ["test"] },
    plan: { type: "pay_as_you_go", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: ["test"] },
    sources: ["test"],
  };
}
