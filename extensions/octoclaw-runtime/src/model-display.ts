import { resolveModelId } from "@octoclaw/policy/model";
import { asString } from "./util/type-coercion.js";

export function isRuntimeProfileModelLabel(value: unknown): boolean {
  const normalized = asString(value).toLowerCase();
  if (!normalized) return true;
  return normalized === "main"
    || normalized === "default"
    || normalized === "direct_main"
    || normalized === "octoclaw-main"
    || normalized === "octoclaw_main"
    || normalized === "worker_default"
    || normalized.startsWith("worker_");
}

function resolveModelCandidate(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";
  const resolved = (() => {
    try {
      return asString(resolveModelId(raw as Parameters<typeof resolveModelId>[0]));
    } catch {
      return "";
    }
  })();
  const candidate = resolved || (isRuntimeProfileModelLabel(raw) ? "" : raw);
  return isRuntimeProfileModelLabel(candidate) ? "" : candidate;
}

export function firstDisplayModel(...values: unknown[]): string {
  for (const value of values) {
    const candidate = resolveModelCandidate(value);
    if (candidate) return candidate;
  }
  return "unknown";
}
