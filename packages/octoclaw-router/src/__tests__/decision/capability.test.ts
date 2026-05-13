import { describe, expect, it, vi } from "vitest";

import {
  computeFreshness,
  ensureCapabilityForConfiguredModels,
  handleOpenClawConfigChange,
  loadPackagedLeaderboardSnapshot,
  loadPackagedModelIntelSnapshot,
  loadSnapshotFromText,
  mergeCapabilitySnapshot,
  mergePriceData,
  refreshCapability,
  type CapabilityOverrideConfig,
  type CapabilitySource,
} from "../../capability/index.js";

describe("capability snapshot RT-C-001..007", () => {
  it("RT-C-001 loads packaged snapshot on cold start", () => {
    const leaderboard = loadPackagedLeaderboardSnapshot();
    const snapshot = loadPackagedModelIntelSnapshot();

    expect(Object.keys(leaderboard.models).length).toBeGreaterThan(0);
    expect(snapshot.models.length).toBeGreaterThan(0);
    expect(snapshot.models.every((model) => model.configured === true)).toBe(true);
  });

  it("RT-C-002 fails open to empty capability data on corrupt snapshot", () => {
    const warn = vi.fn();
    const snapshot = loadSnapshotFromText("{not json", { warn });

    expect(snapshot.models).toEqual([]);
    expect(snapshot.snapshotId).toBe("empty");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[router-lite] snapshot load failed:"));
  });

  it("RT-C-003 refresh probes sources in order and flags price conflicts", async () => {
    const calls: string[] = [];
    const writes: unknown[] = [];
    const sources: CapabilitySource[] = [
      { name: "leaderboard", fetch: async () => (calls.push("leaderboard"), [{ modelKey: "openai/gpt-5.5", price: 10 }]) },
      { name: "openrouter", fetch: async () => (calls.push("openrouter"), [{ modelKey: "openai/gpt-5.5", price: 14 }]) },
      { name: "models.dev", fetch: async () => (calls.push("models.dev"), []) },
      { name: "openclaw", fetch: async () => (calls.push("openclaw"), []) },
    ];

    const snapshot = await refreshCapability({
      sources,
      writeSnapshot: async (value) => {
        writes.push(value);
      },
      now: () => new Date("2026-05-13T00:00:00.000Z").getTime(),
    });

    expect(calls).toEqual(["leaderboard", "openrouter", "models.dev", "openclaw"]);
    expect(snapshot.snapshotId).toBe("snapshot-2026-05-13T00:00:00.000Z");
    expect(snapshot.models[0]?.marketPrice.conflict).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("RT-C-004 handles OpenClaw config changes as incremental refresh", async () => {
    const refresh = vi.fn(async () => undefined);

    await handleOpenClawConfigChange({ refreshCapability: refresh });

    expect(refresh).toHaveBeenCalledWith({ incremental: true });
  });

  it("RT-C-005 looks up unknown configured models and falls back to low-confidence heuristic", async () => {
    const snapshot = loadSnapshotFromText(JSON.stringify({
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "test",
      generatedAt: "2026-05-13T00:00:00.000Z",
      sourceStatus: [],
      models: [],
    }));

    const updated = await ensureCapabilityForConfiguredModels(snapshot, ["deepseek/deepseek-v4"], {
      lookup: async () => null,
    });

    expect(updated.models).toHaveLength(1);
    expect(updated.models[0]).toMatchObject({
      modelKey: "deepseek/deepseek-v4",
      configured: true,
      capability: { confidence: "low", sources: ["heuristic"] },
    });
  });

  it("RT-C-006 tracks stale and very stale capability data", () => {
    const now = new Date("2026-05-13T00:00:00.000Z").getTime();

    expect(computeFreshness("2026-05-01T00:00:00.000Z", now)).toBe("fresh");
    expect(computeFreshness("2026-03-01T00:00:00.000Z", now)).toBe("stale");
    expect(computeFreshness("2026-01-01T00:00:00.000Z", now)).toBe("very_stale");
  });

  it("RT-C-007 keeps user score overrides separate across refresh", () => {
    const overrides: CapabilityOverrideConfig = {
      scoreOverrides: {
        "openai/gpt-5.5": { complex: 75 },
      },
    };
    const refreshed = loadPackagedModelIntelSnapshot();
    const merged = mergeCapabilitySnapshot(refreshed, overrides);

    expect(merged.overrides.scoreOverrides["openai/gpt-5.5"]?.complex).toBe(75);
    expect(merged.snapshot.models.find((model) => model.modelKey === "openai/gpt-5.5")?.capability.codingTier).toBeDefined();
  });

  it("flags price conflict when source prices differ by more than 20 percent", () => {
    expect(mergePriceData("openai/gpt-5.5", [
      { source: "openrouter", price: 10 },
      { source: "models.dev", price: 13 },
    ])).toMatchObject({ price: 13, conflict: true, sources: ["openrouter", "models.dev"] });
  });
});
