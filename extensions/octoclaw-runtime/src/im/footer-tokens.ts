import type { IMProjectionFooter } from "./adapter.js";
import { firstDisplayModel } from "../model-display.js";

/**
 * Format the model token for a footer line. Resolves the raw model through the
 * policy model map (so runtime profile labels like "direct_main" are mapped to
 * a real display name, not leaked verbatim). When a fallback fired this turn,
 * append a ⚡ marker so the user can tell the displayed model is the fallback
 * target, not the route-selected one.
 */
export function formatFooterModelToken(projection: IMProjectionFooter): string {
  const model = firstDisplayModel(projection.model, "direct_main");
  return projection.fallbackUsed ? `${model}⚡` : model;
}

/**
 * Format the turn duration as a compact `time=` token.
 * Returns "" when no duration is available (degraded paths).
 */
export function formatFooterTimeToken(projection: IMProjectionFooter): string {
  if (typeof projection.durationMs !== "number" || !Number.isFinite(projection.durationMs) || projection.durationMs <= 0) {
    return "";
  }
  return `time=${(projection.durationMs / 1000).toFixed(1)}s`;
}
