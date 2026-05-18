export interface OctoClawRuntimeConfig {
  defaultChannel: string;
  defaultNotifyPolicy: "silent" | "default";
  defaultRuntime: "subagent";
}

export const DEFAULT_OCTOCLAW_RUNTIME_CONFIG: OctoClawRuntimeConfig = {
  defaultChannel: "direct",
  defaultNotifyPolicy: "silent",
  defaultRuntime: "subagent",
};

export function resolveRuntimeConfig(
  overrides: Partial<OctoClawRuntimeConfig> = {},
): OctoClawRuntimeConfig {
  return {
    ...DEFAULT_OCTOCLAW_RUNTIME_CONFIG,
    ...overrides,
  };
}

export type SpawnBackend = "planner" | "legacy" | "off";

export function resolveSpawnBackend(): SpawnBackend {
  const v = String(process.env.OCTOCLAW_SPAWN_BACKEND ?? "").trim().toLowerCase();
  if (v === "planner") return "planner";
  if (v === "legacy") return "legacy";
  if (v === "off") return "off";
  return "planner";
}

export function resolvePlannerAllowlist(): string[] {
  const raw = String(process.env.OCTOCLAW_PLANNER_ALLOWLIST ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isPlannerAllowedForSession(sessionKey: string): boolean {
  const allowlist = resolvePlannerAllowlist();
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) => {
    if (pattern === sessionKey) return true;
    if (pattern.endsWith("*") && sessionKey.startsWith(pattern.slice(0, -1))) return true;
    return false;
  });
}

export const DEFAULT_SPAWN_INTENT_TTL_MS = 60_000;

export function resolveSpawnIntentTtlMs(): number {
  const raw = Number(process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SPAWN_INTENT_TTL_MS;
  return Math.max(5_000, Math.min(raw, 300_000));
}

export function resolveSpeculativePreloadEnabled(pluginConfig: Record<string, unknown> | undefined = undefined): boolean {
  const configured = pluginConfig?.speculativePreload ?? pluginConfig?.speculative_preload;
  const envRaw = String(process.env.OCTOCLAW_SPECULATIVE_PRELOAD ?? "").trim();
  const raw = (envRaw || String(configured ?? "")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "enabled";
}

export interface PlannerSpawnConfig {
  spawnBackend: SpawnBackend;
  plannerAllowlist: string[];
  intentTtlMs: number;
}

export function resolvePlannerSpawnConfig(): PlannerSpawnConfig {
  return {
    spawnBackend: resolveSpawnBackend(),
    plannerAllowlist: resolvePlannerAllowlist(),
    intentTtlMs: resolveSpawnIntentTtlMs(),
  };
}
