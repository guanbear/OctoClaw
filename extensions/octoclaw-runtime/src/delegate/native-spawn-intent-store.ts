import type { NativeSpawnIntent, SessionsSpawnArgs } from "./native-spawn-intent.js";
import { computePlanHash, generateSpawnIntentId } from "./native-spawn-intent.js";

export interface CreateIntentParams {
  workContractId: string;
  sessionKey: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  ttlMs: number;
  now?: number;
}

export interface ConfirmAcceptParams {
  spawnIntentId: string;
  workContractId: string;
  runId: string;
  now?: number | Date;
}

export type TransitionResult =
  | { ok: true; intent: NativeSpawnIntent }
  | { ok: false; error: string };

export type ConfirmAcceptResult =
  | { ok: true; intent: NativeSpawnIntent; idempotent: boolean }
  | { ok: false; error: string; existingRunId?: string };

export type ConfirmFailResult =
  | { ok: true; intent: NativeSpawnIntent }
  | { ok: false; error: string };

export class NativeSpawnIntentStore {
  private readonly intents = new Map<string, NativeSpawnIntent>();

  create(params: CreateIntentParams): NativeSpawnIntent {
    const now = params.now ?? Date.now();
    const intent: NativeSpawnIntent = {
      spawnIntentId: generateSpawnIntentId(),
      workContractId: params.workContractId,
      sessionKey: params.sessionKey,
      planHash: computePlanHash(params.sessionsSpawnArgs),
      sessionsSpawnArgs: params.sessionsSpawnArgs,
      status: "planned",
      ttlMs: params.ttlMs,
      createdAt: now,
      expiresAt: now + params.ttlMs,
    };
    this.intents.set(intent.spawnIntentId, intent);
    return intent;
  }

  get(spawnIntentId: string): NativeSpawnIntent | undefined {
    return this.intents.get(spawnIntentId);
  }

  findPendingForSession(sessionKey: string, now?: number): NativeSpawnIntent | undefined {
    const nowMs = now ?? Date.now();
    let latest: NativeSpawnIntent | undefined;
    for (const intent of this.intents.values()) {
      if (intent.sessionKey !== sessionKey) continue;
      if (intent.status !== "planned") continue;
      if (intent.expiresAt < nowMs) {
        intent.status = "expired";
        continue;
      }
      if (!latest || intent.createdAt > latest.createdAt) {
        latest = intent;
      }
    }
    return latest;
  }

  transitionToSpawnStarted(
    spawnIntentId: string,
    expectedPlanHash: string,
    now?: number,
  ): TransitionResult {
    const nowMs = now ?? Date.now();
    const intent = this.intents.get(spawnIntentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.expiresAt < nowMs) {
      intent.status = "expired";
      return { ok: false, error: "intent_expired" };
    }
    if (intent.status !== "planned") return { ok: false, error: "invalid_status" };
    if (intent.planHash !== expectedPlanHash) return { ok: false, error: "args_hash_mismatch" };
    intent.status = "spawn_call_started";
    return { ok: true, intent };
  }

  confirmAccept(params: ConfirmAcceptParams): ConfirmAcceptResult {
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    if (!runId) return { ok: false, error: "runId_required" };

    const nowMs = toMs(params.now);
    const intent = this.intents.get(params.spawnIntentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.expiresAt < nowMs) {
      intent.status = "expired";
      return { ok: false, error: "intent_expired" };
    }
    if (params.workContractId !== intent.workContractId) {
      return { ok: false, error: "work_contract_mismatch" };
    }

    if (intent.status === "accepted") {
      if (intent.openclawRunId === runId) return { ok: true, intent, idempotent: true };
      return { ok: false, error: "runId_conflict", existingRunId: intent.openclawRunId };
    }

    if (intent.status === "spawn_call_started" || intent.status === "planned") {
      intent.status = "accepted";
      intent.openclawRunId = runId;
      intent.confirmedAt = nowMs;
      return { ok: true, intent, idempotent: false };
    }

    return { ok: false, error: "invalid_status" };
  }

  confirmFailed(spawnIntentId: string, error: string, now?: number): ConfirmFailResult {
    const nowMs = now ?? Date.now();
    const intent = this.intents.get(spawnIntentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.expiresAt < nowMs) {
      intent.status = "expired";
      return { ok: false, error: "intent_expired" };
    }
    if (intent.status !== "planned" && intent.status !== "spawn_call_started") {
      return { ok: false, error: "invalid_status" };
    }
    intent.status = "failed";
    intent.error = error;
    return { ok: true, intent };
  }

  markFailed(spawnIntentId: string, error: string): TransitionResult {
    const intent = this.intents.get(spawnIntentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.status !== "planned" && intent.status !== "spawn_call_started") {
      return { ok: false, error: "invalid_status" };
    }
    intent.status = "failed";
    intent.error = error;
    return { ok: true, intent };
  }

  expireElapsed(now?: number): number {
    const nowMs = now ?? Date.now();
    let expired = 0;
    for (const intent of this.intents.values()) {
      if (
        (intent.status === "planned" || intent.status === "spawn_call_started") &&
        intent.expiresAt < nowMs
      ) {
        intent.status = "expired";
        expired += 1;
      }
    }
    return expired;
  }

  clear(): void {
    this.intents.clear();
  }

  size(): number {
    return this.intents.size;
  }
}

function toMs(now: number | Date | undefined): number {
  if (now === undefined) return Date.now();
  if (typeof now === "number") return now;
  return now.getTime();
}
