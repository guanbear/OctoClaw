import type { LiveRoute } from "@octoclaw/policy/route";

export const LIVE_ROUTE_NAMES = new Set<LiveRoute>(["reply", "delegate"]);
export const DELEGATED_ROUTE_NAMES = new Set<string>(["delegate"]);

export function normalizeLiveRoute(route: unknown, fallback: LiveRoute): LiveRoute {
  const normalized = String(route ?? "").trim();
  if (normalized === "direct") return "reply";
  if (normalized === "delegate.single" || normalized === "observe") return "delegate";
  if (normalized === "spawn_single" || normalized === "spawn_multi") return "delegate";
  if (normalized === "runner") return "delegate";
  if (LIVE_ROUTE_NAMES.has(normalized as LiveRoute)) return normalized as LiveRoute;
  return fallback;
}

export function isDelegatedRoute(route: unknown): boolean {
  return normalizeLiveRoute(route, "reply") === "delegate";
}

export function isObserveMode(role?: string, executionProfile?: string): boolean {
  return role === "observer_probe" || executionProfile === "observer";
}
