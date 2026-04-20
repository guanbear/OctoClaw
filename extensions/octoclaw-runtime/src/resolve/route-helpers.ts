import type { LiveRoute } from "@octoclaw/policy/route";

export const LIVE_ROUTE_NAMES = new Set<LiveRoute>(["reply", "delegate.single", "observe"]);
export const DELEGATED_ROUTE_NAMES = new Set<string>(["delegate.single"]);

export function normalizeLiveRoute(route: unknown, fallback: LiveRoute): LiveRoute {
  const normalized = String(route ?? "").trim();
  if (normalized === "direct") return "reply";
  if (normalized === "spawn_single" || normalized === "spawn_multi") return "delegate.single";
  if (normalized === "runner") return "observe";
  if (LIVE_ROUTE_NAMES.has(normalized as LiveRoute)) return normalized as LiveRoute;
  return fallback;
}

export function isDelegatedRoute(route: unknown): boolean {
  return normalizeLiveRoute(route, "reply") === "delegate.single";
}
