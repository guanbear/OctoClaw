import { evaluateCooldown, type CooldownReason } from "./cooldown.js";
import type { HealthEvent } from "./event.js";

export interface RouterModelHealthSnapshot {
  sampleCount: number;
  windowStartedAt?: number;
  windowEndedAt?: number;
  recentFailureRate: number;
  toolCallFailureRate: number;
  timeoutRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  baselineP95LatencyMs?: number;
  baselineP95WindowCount?: number;
  lastErrorCodes: Array<{ code: string; count: number }>;
  lastSuccessfulCallAt?: number;
  lastFailedCallAt?: number;
  cooldown: boolean;
  cooldownUntil?: number;
  cooldownReason?: CooldownReason;
}

export interface RouterHealthSnapshot {
  schemaVersion: "octoclaw.router.health_snapshot/v1";
  generatedAt: number;
  windowMs: number;
  windowSize: number;
  models: Record<string, RouterModelHealthSnapshot>;
}

export interface AggregateHealthOptions {
  windowMs?: number;
  windowSize?: number;
  baselineP95ByModel?: Record<string, number | undefined>;
}

const DEFAULT_WINDOW_MS = 30 * 60_000;
const DEFAULT_WINDOW_SIZE = 50;
const DAY_MS = 24 * 60 * 60_000;
const BASELINE_DAILY_WINDOW_COUNT = 7;
const MIN_BASELINE_DAILY_WINDOWS = 3;

export function aggregateHealth(events: HealthEvent[], now: number, options: AggregateHealthOptions = {}): RouterHealthSnapshot {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const grouped = new Map<string, HealthEvent[]>();
  const baselineByModel = computeBaselineP95ByModel(events, now);

  for (const event of events) {
    if (now - event.ts > windowMs) continue;
    const group = grouped.get(event.modelKey) ?? [];
    group.push(event);
    grouped.set(event.modelKey, group);
  }

  const models: Record<string, RouterModelHealthSnapshot> = {};
  for (const modelKey of [...grouped.keys()].sort()) {
    const selected = grouped.get(modelKey)!
      .sort(compareHealthEvents)
      .slice(-windowSize);
    const computedBaseline = baselineByModel.get(modelKey);
    const baselineP95Ms = options.baselineP95ByModel?.[modelKey] ?? computedBaseline?.p95LatencyMs;
    models[modelKey] = summarizeModelHealth(
      selected,
      evaluateCooldown({
        events: selected,
        now,
        baselineP95Ms,
      }),
      computedBaseline,
    );
  }

  return {
    schemaVersion: "octoclaw.router.health_snapshot/v1",
    generatedAt: now,
    windowMs,
    windowSize,
    models,
  };
}

export function serializeHealthSnapshot(snapshot: RouterHealthSnapshot): string {
  const models: Record<string, RouterModelHealthSnapshot> = {};
  for (const key of Object.keys(snapshot.models).sort()) {
    models[key] = snapshot.models[key];
  }
  return `${JSON.stringify({ ...snapshot, models }, null, 2)}\n`;
}

function summarizeModelHealth(
  events: HealthEvent[],
  cooldown: ReturnType<typeof evaluateCooldown>,
  baseline?: { p95LatencyMs: number; windowCount: number },
): RouterModelHealthSnapshot {
  const sorted = [...events].sort(compareHealthEvents);
  const latencies = sorted
    .map((event) => event.latencyMs)
    .filter((latency): latency is number => typeof latency === "number")
    .sort((left, right) => left - right);
  const failed = sorted.filter((event) => !event.success);
  const lastSuccess = [...sorted].reverse().find((event) => event.success);
  const lastFailure = [...sorted].reverse().find((event) => !event.success);
  const summary: RouterModelHealthSnapshot = {
    sampleCount: sorted.length,
    windowStartedAt: sorted.at(0)?.ts,
    windowEndedAt: sorted.at(-1)?.ts,
    recentFailureRate: rate(failed.length, sorted.length),
    toolCallFailureRate: rate(sorted.filter((event) => event.toolCallFailed === true).length, sorted.length),
    timeoutRate: rate(sorted.filter((event) => event.timeout === true).length, sorted.length),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    baselineP95LatencyMs: baseline?.p95LatencyMs,
    baselineP95WindowCount: baseline?.windowCount,
    lastErrorCodes: countErrorCodes(sorted),
    lastSuccessfulCallAt: lastSuccess?.ts,
    lastFailedCallAt: lastFailure?.ts,
    cooldown: cooldown.cooldown,
  };
  if (cooldown.cooldown) {
    summary.cooldownUntil = cooldown.cooldownUntil;
    summary.cooldownReason = cooldown.reason;
  }
  return summary;
}

function computeBaselineP95ByModel(events: HealthEvent[], now: number): Map<string, { p95LatencyMs: number; windowCount: number }> {
  const currentDayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const oldestIncludedDayStart = currentDayStart - BASELINE_DAILY_WINDOW_COUNT * DAY_MS;
  const dailyLatenciesByModel = new Map<string, Map<number, number[]>>();

  for (const event of events) {
    if (event.ts >= currentDayStart || event.ts < oldestIncludedDayStart) continue;
    if (typeof event.latencyMs !== "number") continue;
    const dayStart = Math.floor(event.ts / DAY_MS) * DAY_MS;
    const byDay = dailyLatenciesByModel.get(event.modelKey) ?? new Map<number, number[]>();
    const latencies = byDay.get(dayStart) ?? [];
    latencies.push(event.latencyMs);
    byDay.set(dayStart, latencies);
    dailyLatenciesByModel.set(event.modelKey, byDay);
  }

  const baselines = new Map<string, { p95LatencyMs: number; windowCount: number }>();
  for (const [modelKey, byDay] of dailyLatenciesByModel) {
    const dailyP95s = [...byDay.entries()]
      .sort(([leftDay], [rightDay]) => leftDay - rightDay)
      .slice(-BASELINE_DAILY_WINDOW_COUNT)
      .map(([, latencies]) => percentile([...latencies].sort((left, right) => left - right), 0.95))
      .filter((latency): latency is number => typeof latency === "number");
    if (dailyP95s.length < MIN_BASELINE_DAILY_WINDOWS) continue;
    baselines.set(modelKey, {
      p95LatencyMs: median(dailyP95s),
      windowCount: dailyP95s.length,
    });
  }
  return baselines;
}

function compareHealthEvents(left: HealthEvent, right: HealthEvent): number {
  return left.ts - right.ts
    || left.modelKey.localeCompare(right.modelKey)
    || left.source.localeCompare(right.source)
    || Number(left.success) - Number(right.success)
    || (left.errorCode ?? "").localeCompare(right.errorCode ?? "");
}

function countErrorCodes(events: HealthEvent[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!event.errorCode) continue;
    counts.set(event.errorCode, (counts.get(event.errorCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => rightCount - leftCount || leftCode.localeCompare(rightCode))
    .slice(0, 3)
    .map(([code, count]) => ({ code, count }));
}

function rate(count: number, total: number): number {
  if (total === 0) return 0;
  return count / total;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
