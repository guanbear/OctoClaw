import { fallbackRoute } from "./fallback.js";
import { computeJudgeCacheKey, JudgeCache } from "./judge-cache.js";
import { JudgeHealthTracker } from "./judge-health.js";
import { isValidJudgeOutput, type JudgeInput, type JudgeOutput } from "./judge-schema.js";

export type JudgeFallbackReason =
  | "status_or_provenance_request"
  | "session_control_request"
  | "cooldown_active"
  | "parse_failed"
  | "validation_failed"
  | "timeout"
  | "exception";

export interface JudgeTelemetryEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
}

export interface SemanticJudgeOptions {
  judgeModelId: string;
  callJudgeModel: (input: JudgeInput, options: { timeoutMs: number }) => Promise<unknown>;
  cache?: JudgeCache;
  health?: JudgeHealthTracker;
  telemetryEmitter?: JudgeTelemetryEmitter;
  timeoutMs?: number;
  cacheEnabled?: boolean;
}

export class SemanticJudge {
  private readonly cache: JudgeCache;
  private readonly health: JudgeHealthTracker;

  constructor(private readonly options: SemanticJudgeOptions) {
    this.cache = options.cache ?? new JudgeCache();
    this.health = options.health ?? new JudgeHealthTracker();
  }

  async judge(input: JudgeInput): Promise<JudgeOutput> {
    if (input.runtimeSignals?.statusOrProvenanceRequest) {
      this.emit("router_judge_skipped", { reason: "status_or_provenance_request" });
      return fallbackRoute(input);
    }
    if (input.runtimeSignals?.sessionControlRequest) {
      this.emit("router_judge_skipped", { reason: "session_control_request" });
      return fallbackRoute(input);
    }

    const prompt = input.prompt ?? input.userMessage ?? "";
    const cacheKey = computeJudgeCacheKey({
      prompt,
      sessionKey: input.sessionKey ?? input.sessionBinding ?? "",
      recentExecution: input.recentExecution ?? null,
      judgeModelId: this.options.judgeModelId,
      snapshotId: input.snapshotId ?? "default",
    });

    if (this.options.cacheEnabled !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.emit("router_judge_cache_hit", { cacheKey });
        return cached;
      }
    }

    if (this.health.isInCooldown()) {
      this.emitFallback("cooldown_active");
      return fallbackRoute(input);
    }

    try {
      const raw = await this.withTimeout(
        this.options.callJudgeModel(input, { timeoutMs: this.timeoutMs() }),
        this.timeoutMs(),
      );
      const parsed = typeof raw === "string" ? tryParseJudgeJson(raw) : raw;
      if (parsed === null) {
        this.health.recordFailure("parse_failed");
        this.emitFallback("parse_failed");
        return fallbackRoute(input);
      }
      if (!isValidJudgeOutput(parsed)) {
        this.health.recordFailure("validation_failed");
        this.emitFallback("validation_failed");
        return fallbackRoute(input);
      }
      this.cache.set(cacheKey, parsed);
      this.health.recordSuccess();
      return parsed;
    } catch (error) {
      const reason = isTimeoutError(error) ? "timeout" : "exception";
      this.health.recordFailure(reason);
      this.emitFallback(reason);
      return fallbackRoute(input);
    }
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? 2000;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.options.telemetryEmitter?.emit(event, payload);
  }

  private emitFallback(reason: JudgeFallbackReason): void {
    this.emit("router_judge_fallback", { reason });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createSemanticJudge(options: SemanticJudgeOptions): SemanticJudge {
  return new SemanticJudge(options);
}

export function tryParseJudgeJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const cleaned = trimmed.replace(/[\x00-\x1f\x7f]/g, " ");
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

class TimeoutError extends Error {
  constructor() {
    super("judge timeout");
    this.name = "TimeoutError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof TimeoutError;
}
