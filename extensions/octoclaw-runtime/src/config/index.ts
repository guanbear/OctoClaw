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

export const DEFAULT_SPAWN_INTENT_TTL_MS = 60_000;

function envValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function envFlag(name: string): boolean {
  const value = envValue(name).toLowerCase();
  return value === "1" || value === "true";
}

export function resolveSpawnBackend(): SpawnBackend {
  const value = envValue("OCTOCLAW_SPAWN_BACKEND").toLowerCase();
  if (value === "planner" || value === "legacy" || value === "off") return value;
  return "legacy";
}

export function resolvePlannerAllowlist(): string[] {
  return envValue("OCTOCLAW_PLANNER_ALLOWLIST")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Empty allowlist intentionally means all sessions when the planner backend is enabled.
export function isPlannerAllowedForSession(sessionKey: string, allowlist = resolvePlannerAllowlist()): boolean {
  const key = String(sessionKey ?? "").trim();
  if (!key) return false;
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === key) return true;
    if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
    return false;
  });
}

export function resolveSpawnIntentTtlMs(): number {
  const parsed = Number(envValue("OCTOCLAW_SPAWN_INTENT_TTL_MS"));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SPAWN_INTENT_TTL_MS;
  return Math.max(5_000, Math.min(Math.floor(parsed), 300_000));
}

export function resolveLegacyCompletionFileEnabled(): boolean {
  return envFlag("OCTOCLAW_LEGACY_COMPLETION_FILE");
}

export function resolveLegacyChildFinalizerDisabled(): boolean {
  return envFlag("OCTOCLAW_DISABLE_CHILD_FINALIZER");
}

export function resolveLegacyDeliveryOutboxDisabled(): boolean {
  return envFlag("OCTOCLAW_DISABLE_DELIVERY_OUTBOX");
}

export type RuntimeLedgerLegacyMode = "on" | "read_only" | "off";

export function resolveLegacyRuntimeLedgerMode(): RuntimeLedgerLegacyMode {
  const value = envValue("OCTOCLAW_LEGACY_RUNTIME_LEDGER").toLowerCase();
  if (value === "read_only" || value === "off") return value;
  return "on";
}

export interface PlannerSpawnConfig {
  spawnBackend: SpawnBackend;
  plannerAllowlist: string[];
  intentTtlMs: number;
  legacyCompletionFileEnabled: boolean;
  legacyChildFinalizerDisabled: boolean;
  legacyDeliveryOutboxDisabled: boolean;
  legacyRuntimeLedgerMode: RuntimeLedgerLegacyMode;
}

export function resolvePlannerSpawnConfig(): PlannerSpawnConfig {
  return {
    spawnBackend: resolveSpawnBackend(),
    plannerAllowlist: resolvePlannerAllowlist(),
    intentTtlMs: resolveSpawnIntentTtlMs(),
    legacyCompletionFileEnabled: resolveLegacyCompletionFileEnabled(),
    legacyChildFinalizerDisabled: resolveLegacyChildFinalizerDisabled(),
    legacyDeliveryOutboxDisabled: resolveLegacyDeliveryOutboxDisabled(),
    legacyRuntimeLedgerMode: resolveLegacyRuntimeLedgerMode(),
  };
}
