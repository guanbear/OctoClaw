export interface ModelHealthCallResult {
  success: boolean;
  errorCode?: string;
  latencyMs?: number;
}

export * from "./cooldown.js";
export * from "./event.js";
export * from "./sink.js";
export * from "./snapshot.js";
export * from "./suggestions.js";

export interface ModelHealthSnapshot {
  recentFailureRate: number;
  cooldown: boolean;
  cooldownUntil?: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
}

export class ModelHealthTracker {
  private readonly callLog = new Map<string, Array<{ timestamp: number } & ModelHealthCallResult>>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowSize = 50,
    private readonly windowMs = 30 * 60 * 1000,
  ) {}

  recordCall(model: string, result: ModelHealthCallResult): void {
    const log = this.callLog.get(model) ?? [];
    log.push({ timestamp: this.now(), ...result });
    const trimmed = log
      .filter((entry) => this.now() - entry.timestamp <= this.windowMs)
      .slice(-this.windowSize);
    this.callLog.set(model, trimmed);

    if (result.errorCode === "429") {
      this.cooldownUntil.set(model, this.now() + 10 * 60 * 1000);
      return;
    }

    if (trimmed.length >= 10 && this.failureRate(trimmed) >= 0.20) {
      this.cooldownUntil.set(model, this.now() + 30 * 60 * 1000);
    }
  }

  snapshot(model: string): ModelHealthSnapshot {
    const log = this.callLog.get(model) ?? [];
    const cooldownUntil = this.cooldownUntil.get(model);
    if (cooldownUntil !== undefined && this.now() >= cooldownUntil) {
      this.cooldownUntil.delete(model);
    }
    const activeCooldownUntil = this.cooldownUntil.get(model);
    const latencies = log
      .map((entry) => entry.latencyMs)
      .filter((latency): latency is number => typeof latency === "number")
      .sort((left, right) => left - right);

    return {
      recentFailureRate: this.failureRate(log),
      cooldown: activeCooldownUntil !== undefined,
      cooldownUntil: activeCooldownUntil,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
    };
  }

  private failureRate(log: ModelHealthCallResult[]): number {
    if (log.length === 0) return 0;
    return log.filter((entry) => !entry.success).length / log.length;
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}
