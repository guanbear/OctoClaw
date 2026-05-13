import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ModelIntelSnapshot } from "@octoclaw/router/decision";

const DEFAULT_SNAPSHOT_PATH_ENV = "OCTOCLAW_ROUTER_SNAPSHOT_PATH";
const SNAPSHOT_CACHE_TTL_MS = 60_000;

interface CachedSnapshot {
  snapshot: ModelIntelSnapshot;
  loadedAt: number;
  mtimeMs: number;
  path: string;
}

let cached: CachedSnapshot | null = null;

export function resolveSnapshotPath(): string {
  const override = process.env[DEFAULT_SNAPSHOT_PATH_ENV];
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".openclaw", "workspace", "tmp", "octopus", "router-lite", "model-intel-snapshot.json");
}

function isValidSnapshot(value: unknown): value is ModelIntelSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "octoclaw.router_lite.model_intel_snapshot/v1"
    && Array.isArray(record.models)
    && typeof record.snapshotId === "string";
}

/**
 * Load the cached model-intel snapshot from disk.
 * Returns null on any error (missing file, corrupt JSON, wrong schema).
 * Never throws.
 */
export function loadRouterLiteSnapshot(): ModelIntelSnapshot | null {
  try {
    const targetPath = resolveSnapshotPath();
    const stat = fsSync.statSync(targetPath);
    const now = Date.now();

    if (
      cached
      && cached.path === targetPath
      && cached.mtimeMs === stat.mtimeMs
      && (now - cached.loadedAt) < SNAPSHOT_CACHE_TTL_MS
    ) {
      return cached.snapshot;
    }

    const raw = fsSync.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSnapshot(parsed)) return null;

    cached = { snapshot: parsed, loadedAt: now, mtimeMs: stat.mtimeMs, path: targetPath };
    return parsed;
  } catch {
    return null;
  }
}

export function resolveShadowEventPath(): string {
  const override = process.env.OCTOCLAW_ROUTER_SHADOW_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".openclaw", "workspace", "tmp", "octopus", "router-lite", "shadow.jsonl");
}

/** For testing: clear the in-memory cache. */
export function resetSnapshotCacheForTests(): void {
  cached = null;
}
