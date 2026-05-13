import { readFileSync } from "node:fs";

import type { ModelIntelSnapshot } from "../decision/contracts.js";
import { modelFromLeaderboard } from "./merge.js";
import type { LeaderboardSnapshot } from "./types.js";

const PACKAGED_SNAPSHOT_URL = new URL("../data/leaderboard-snapshot.json", import.meta.url);

export interface SnapshotLoadOptions {
  warn?: (message: string) => void;
}

export function loadPackagedLeaderboardSnapshot(options: SnapshotLoadOptions = {}): LeaderboardSnapshot {
  return loadLeaderboardFromText(readFileSync(PACKAGED_SNAPSHOT_URL.pathname, "utf-8"), options);
}

export function loadPackagedModelIntelSnapshot(options: SnapshotLoadOptions = {}): ModelIntelSnapshot {
  const leaderboard = loadPackagedLeaderboardSnapshot(options);
  const models = Object.keys(leaderboard.models)
    .flatMap((modelKey) => {
      const model = modelFromLeaderboard(modelKey, leaderboard);
      return model ? [model] : [];
    });

  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: leaderboard.snapshotVersion,
    generatedAt: "2026-05-13T00:00:00.000Z",
    sourceStatus: leaderboard.sources.map((source) => ({ source, status: "ok" })),
    models,
  };
}

export function loadSnapshotFromText(text: string, options: SnapshotLoadOptions = {}): ModelIntelSnapshot {
  try {
    const parsed = JSON.parse(text) as ModelIntelSnapshot;
    if (!Array.isArray(parsed.models)) throw new Error("snapshot models must be an array");
    return parsed;
  } catch (error) {
    options.warn?.(`[router-lite] snapshot load failed: ${String(error)}`);
    return emptySnapshot();
  }
}

function loadLeaderboardFromText(text: string, options: SnapshotLoadOptions): LeaderboardSnapshot {
  try {
    const parsed = JSON.parse(text) as LeaderboardSnapshot;
    if (!parsed.models || typeof parsed.models !== "object") throw new Error("leaderboard models must be an object");
    return parsed;
  } catch (error) {
    options.warn?.(`[router-lite] snapshot load failed: ${String(error)}`);
    return { snapshotVersion: "empty", schemaVersion: "1.0", sources: [], models: {} };
  }
}

function emptySnapshot(): ModelIntelSnapshot {
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "empty",
    generatedAt: new Date(0).toISOString(),
    sourceStatus: [],
    models: [],
  };
}
