export type LegacyHeuristicMode = "read_only" | "off";
export type LegacyHeuristicSurface =
  | "status_projection"
  | "dispatch_guard"
  | "message_guard"
  | "delivery_projection"
  | "result_projection";

export interface LegacyHeuristicVerdictInput {
  surface: LegacyHeuristicSurface;
  hasNativeTruth: boolean;
  hasKnownNativeId: boolean;
  hasLegacySignal: boolean;
  newTask: boolean;
  reason: string;
}

export interface LegacyHeuristicVerdict {
  allowed: boolean;
  readOnly: true;
  reason: string;
  source: "legacy_heuristic_read_only" | "none";
}

export interface LegacyHeuristicFallbackEventInput {
  taskId?: string;
  workContractId?: string;
  surface: LegacyHeuristicSurface;
  reason: string;
  newTask: boolean;
  allowed: boolean;
}

export function resolveLegacyHeuristicMode(env: Record<string, string | undefined> = process.env): LegacyHeuristicMode {
  const value = String(env.OCTOCLAW_LEGACY_HEURISTIC_MODE ?? "").trim().toLowerCase();
  return value === "off" ? "off" : "read_only";
}

export function legacyHeuristicVerdict(input: LegacyHeuristicVerdictInput): LegacyHeuristicVerdict {
  if (!input.hasLegacySignal || input.hasNativeTruth || input.hasKnownNativeId || resolveLegacyHeuristicMode() === "off") {
    return {
      allowed: false,
      readOnly: true,
      reason: input.hasNativeTruth || input.hasKnownNativeId ? "native_kind_present" : input.reason || "legacy_heuristic_unavailable",
      source: "none",
    };
  }

  return {
    allowed: input.surface === "status_projection" && !input.newTask,
    readOnly: true,
    reason: input.reason || (input.newTask ? "no_native_spawn_evidence" : "native_fields_absent"),
    source: "legacy_heuristic_read_only",
  };
}

export function buildLegacyHeuristicFallbackEvent(input: LegacyHeuristicFallbackEventInput): Record<string, unknown> {
  return {
    event: "legacy_heuristic_fallback_used",
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.workContractId ? { workContractId: input.workContractId } : {}),
    surface: input.surface,
    reason: input.reason,
    newTask: input.newTask,
    readOnly: true,
    allowed: input.allowed,
  };
}
