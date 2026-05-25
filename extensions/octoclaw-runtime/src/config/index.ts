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

function resolveBooleanFeatureFlag(
  envName: string,
  configValues: unknown[],
): boolean {
  const envRaw = String(process.env[envName] ?? "").trim();
  const rawValue = envRaw || String(configValues.find((value) => value !== undefined) ?? "");
  const raw = rawValue.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "enabled" || raw === "on" || raw === "yes";
}

export function resolveRouteHintHardPreconditionEnabled(pluginConfig: Record<string, unknown> | undefined = undefined): boolean {
  return resolveBooleanFeatureFlag("OCTOCLAW_ROUTE_HINT_HARD_PRECONDITION", [
    pluginConfig?.routeHintHardPrecondition,
    pluginConfig?.route_hint_hard_precondition,
  ]);
}

export function resolveAutomaticRetryAutomationEnabled(pluginConfig: Record<string, unknown> | undefined = undefined): boolean {
  return resolveBooleanFeatureFlag("OCTOCLAW_AUTOMATIC_RETRY_AUTOMATION", [
    pluginConfig?.automaticRetryAutomation,
    pluginConfig?.automatic_retry_automation,
  ]);
}

export type BudgetedMainWallTimeMode = "observe_only" | "escalate";

export function resolveBudgetedMainWallTimeMode(pluginConfig: Record<string, unknown> | undefined = undefined): BudgetedMainWallTimeMode {
  const configured = pluginConfig?.budgetedMainWallTimeMode ?? pluginConfig?.budgeted_main_wall_time_mode;
  const raw = String(process.env.OCTOCLAW_BUDGETED_MAIN_WALL_TIME_MODE || configured || "").trim().toLowerCase();
  return raw === "escalate" ? "escalate" : "observe_only";
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
