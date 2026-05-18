import type { HealthEvent } from "./event.js";

export type CooldownReason = "rate_limit_429" | "provider_quota_402" | "probe_failure" | "high_failure_rate" | "high_p95_drift";

export interface CooldownEvaluationInput {
  events: HealthEvent[];
  now: number;
  baselineP95Ms?: number;
}

export type CooldownEvaluation =
  | { cooldown: false }
  | { cooldown: true; cooldownUntil: number; reason: CooldownReason };

export function evaluateCooldown(input: CooldownEvaluationInput): CooldownEvaluation {
  const events = [...input.events].sort((left, right) => left.ts - right.ts);
  const latest = events.at(-1);

  if (latest && !latest.success && isRateLimit(latest.errorCode)) {
    return {
      cooldown: true,
      cooldownUntil: input.now + 10 * 60_000,
      reason: "rate_limit_429",
    };
  }

  if (latest && !latest.success && isProviderQuota(latest.errorCode)) {
    return {
      cooldown: true,
      cooldownUntil: input.now + 10 * 60_000,
      reason: "provider_quota_402",
    };
  }

  if (latest?.source === "probe" && latest.success === false) {
    return {
      cooldown: true,
      cooldownUntil: input.now + 30 * 60_000,
      reason: "probe_failure",
    };
  }

  if (events.length >= 10) {
    const failureRate = events.filter((event) => !event.success).length / events.length;
    if (failureRate >= 0.20) {
      return {
        cooldown: true,
        cooldownUntil: input.now + 30 * 60_000,
        reason: "high_failure_rate",
      };
    }

    const p95 = percentile(events
      .map((event) => event.latencyMs)
      .filter((latency): latency is number => typeof latency === "number")
      .sort((left, right) => left - right), 0.95);
    if (p95 !== undefined && input.baselineP95Ms !== undefined && input.baselineP95Ms > 0 && p95 > input.baselineP95Ms * 2.5) {
      return {
        cooldown: true,
        cooldownUntil: input.now + 15 * 60_000,
        reason: "high_p95_drift",
      };
    }
  }

  return { cooldown: false };
}

function isRateLimit(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  const normalized = errorCode.toLowerCase();
  return normalized === "429" || normalized === "rate_limit" || normalized.includes("rate_limit_429");
}

function isProviderQuota(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  const normalized = errorCode.toLowerCase();
  return normalized === "402" || normalized.includes("payment_required") || normalized.includes("provider_quota_402");
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}
