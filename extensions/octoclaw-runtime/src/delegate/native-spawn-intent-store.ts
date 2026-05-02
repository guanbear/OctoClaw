import {
  generateSpawnIntentId,
  hashSessionsSpawnArgs,
  type NativeSpawnIntent,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";

export interface CreateIntentParams {
  workContractId: string;
  sessionKey: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  ttlMs: number;
}

export interface ConfirmAcceptParams {
  spawnIntentId: string;
  runId: string;
  now?: Date;
}

export type TransitionResult =
  | { ok: true; intent: NativeSpawnIntent }
  | { ok: false; error: string };

export type ConfirmResult =
  | { ok: true; intent: NativeSpawnIntent; idempotent: boolean }
  | { ok: false; error: string; existingRunId?: string };

export class NativeSpawnIntentStore {
  private readonly intents = new Map<string, NativeSpawnIntent>();

  create(params: CreateIntentParams): NativeSpawnIntent {
    const createdAtDate = new Date();
    const createdAt = createdAtDate.toISOString();
    const intent: NativeSpawnIntent = {
      spawnIntentId: generateSpawnIntentId(),
      workContractId: params.workContractId,
      sessionKey: params.sessionKey,
      canonicalArgsHash: hashSessionsSpawnArgs(params.sessionsSpawnArgs),
      sessionsSpawnArgs: params.sessionsSpawnArgs,
      status: "planned",
      runId: null,
      ttlMs: params.ttlMs,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(createdAtDate.getTime() + params.ttlMs).toISOString(),
    };
    this.intents.set(intent.spawnIntentId, intent);
    return intent;
  }

  get(spawnIntentId: string): NativeSpawnIntent | undefined {
    return this.intents.get(spawnIntentId);
  }

  getPendingForSession(sessionKey: string): NativeSpawnIntent | undefined {
    return [...this.intents.values()]
      .filter((intent) => intent.sessionKey === sessionKey && intent.status === "planned")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  }

  transitionToSpawnStarted(spawnIntentId: string, now: Date = new Date()): TransitionResult {
    const intent = this.intents.get(spawnIntentId);
    if (!intent) return { ok: false, error: "not_found" };
    if (isExpired(intent, now)) {
      markExpired(intent, now);
      return { ok: false, error: "expired" };
    }
    if (intent.status !== "planned") return { ok: false, error: "invalid_status" };
    intent.status = "spawn_call_started";
    intent.updatedAt = now.toISOString();
    return { ok: true, intent };
  }

  confirmAccept(params: ConfirmAcceptParams): ConfirmResult {
    const runId = params.runId.trim();
    if (!runId) return { ok: false, error: "missing_runId" };

    const now = params.now ?? new Date();
    const intent = this.intents.get(params.spawnIntentId);
    if (!intent) return { ok: false, error: "not_found" };
    if (isExpired(intent, now)) {
      markExpired(intent, now);
      return { ok: false, error: "expired" };
    }

    if (intent.status === "accepted") {
      if (intent.runId === runId) return { ok: true, intent, idempotent: true };
      return { ok: false, error: "conflict", existingRunId: intent.runId ?? undefined };
    }

    if (intent.status === "spawn_call_started") {
      intent.status = "accepted";
      intent.runId = runId;
      intent.updatedAt = now.toISOString();
      return { ok: true, intent, idempotent: false };
    }

    return { ok: false, error: "invalid_status" };
  }

  confirmFailed(spawnIntentId: string, now: Date = new Date()): ConfirmResult {
    const intent = this.intents.get(spawnIntentId);
    if (!intent) return { ok: false, error: "not_found" };
    if (isExpired(intent, now)) {
      markExpired(intent, now);
      return { ok: false, error: "expired" };
    }
    if (intent.status !== "planned" && intent.status !== "spawn_call_started") {
      return { ok: false, error: "invalid_status" };
    }
    intent.status = "failed";
    intent.updatedAt = now.toISOString();
    return { ok: true, intent, idempotent: false };
  }

  expirePending(now: Date = new Date()): number {
    let expired = 0;
    for (const intent of this.intents.values()) {
      if ((intent.status === "planned" || intent.status === "spawn_call_started") && isExpired(intent, now)) {
        markExpired(intent, now);
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

function isExpired(intent: NativeSpawnIntent, now: Date): boolean {
  return Date.parse(intent.expiresAt) < now.getTime();
}

function markExpired(intent: NativeSpawnIntent, now: Date): void {
  intent.status = "expired";
  intent.updatedAt = now.toISOString();
}
