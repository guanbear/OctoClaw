import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeSessionsSpawnArgs,
  computePlanHash,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";
import { NativeSpawnIntentStore } from "./native-spawn-intent-store.js";

const baseArgs: SessionsSpawnArgs = {
  task: "Implement a focused deliverable with clear success criteria.",
  model: "gpt-5.5",
  cwd: "/workspace/octoclaw",
};

function createStore(): NativeSpawnIntentStore {
  return new NativeSpawnIntentStore();
}

function createIntent(store = createStore(), ttlMs = 60_000) {
  return store.create({
    workContractId: "wc_1",
    sessionKey: "parent_session_1",
    sessionsSpawnArgs: baseArgs,
    ttlMs,
  });
}

function advanceToSpawnStarted(store: NativeSpawnIntentStore) {
  const intent = createIntent(store);
  store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);
  return intent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical args hash", () => {
  it("produces stable hash for identical args", () => {
    expect(computePlanHash(baseArgs)).toBe(computePlanHash(baseArgs));
  });

  it("produces different hash for different args", () => {
    expect(computePlanHash(baseArgs)).not.toBe(
      computePlanHash({ ...baseArgs, task: "different task" }),
    );
  });

  it("is key-order independent", () => {
    expect(computePlanHash({ task: "a", model: "b" })).toBe(
      computePlanHash({ model: "b", task: "a" }),
    );
  });

  it("handles extra keys", () => {
    expect(computePlanHash({ task: "a", model: "b", extra: true })).not.toBe(
      computePlanHash({ task: "a", model: "b" }),
    );
  });

  it("produces 64-char SHA-256 hex", () => {
    expect(computePlanHash(baseArgs)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches manual SHA-256 of canonical JSON", () => {
    const canonical = canonicalizeSessionsSpawnArgs(baseArgs);
    const expected = crypto.createHash("sha256").update(canonical).digest("hex");
    expect(computePlanHash(baseArgs)).toBe(expected);
  });
});

describe("NativeSpawnIntentStore create and get", () => {
  it("creates intent with planned status", () => {
    const store = createStore();
    const intent = createIntent(store);

    expect(intent.spawnIntentId).toMatch(/^nsp_/);
    expect(intent.workContractId).toBe("wc_1");
    expect(intent.sessionKey).toBe("parent_session_1");
    expect(intent.sessionsSpawnArgs).toBe(baseArgs);
    expect(intent.status).toBe("planned");
    expect(intent.openclawRunId).toBeUndefined();
    expect(typeof intent.createdAt).toBe("number");
    expect(typeof intent.expiresAt).toBe("number");
    expect(store.get(intent.spawnIntentId)).toBe(intent);
    expect(store.size()).toBe(1);
  });

  it("generates unique spawnIntentId", () => {
    const store = createStore();
    const first = createIntent(store);
    const second = createIntent(store);
    expect(first.spawnIntentId).not.toBe(second.spawnIntentId);
  });

  it("computes plan hash", () => {
    const intent = createIntent();
    const manualHash = crypto
      .createHash("sha256")
      .update(canonicalizeSessionsSpawnArgs(baseArgs))
      .digest("hex");
    expect(intent.planHash).toBe(manualHash);
  });

  it("calculates expiresAt from createdAt + ttlMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const intent = createIntent(createStore(), 1_500);
    const expectedCreated = new Date("2026-05-02T12:00:00.000Z").getTime();
    expect(intent.createdAt).toBe(expectedCreated);
    expect(intent.expiresAt).toBe(expectedCreated + 1_500);
  });
});

describe("NativeSpawnIntentStore TTL expiration", () => {
  it("expires planned intents past TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store, 100);

    vi.advanceTimersByTime(101);

    expect(store.expireElapsed()).toBe(1);
    expect(intent.status).toBe("expired");
  });

  it("does not expire intents within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    createIntent(store, 100);

    vi.advanceTimersByTime(100);

    expect(store.expireElapsed()).toBe(0);
  });

  it("returns count of expired intents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    createIntent(store, 50);
    createIntent(store, 100);
    createIntent(store, 500);

    vi.advanceTimersByTime(101);

    expect(store.expireElapsed()).toBe(2);
  });
});

describe("NativeSpawnIntentStore state transitions", () => {
  it("transitions planned to spawn_call_started", () => {
    const store = createStore();
    const intent = createIntent(store);
    const result = store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("spawn_call_started");
    }
  });

  it("rejects transition from non-planned status", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);

    const result = store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);
    expect(result).toEqual({ ok: false, error: "invalid_status" });
  });

  it("rejects transition for expired intent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store, 100);

    vi.advanceTimersByTime(101);
    const result = store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);

    expect(result).toEqual({ ok: false, error: "intent_expired" });
    expect(intent.status).toBe("expired");
  });

  it("rejects transition for not-found intent", () => {
    const store = createStore();
    const result = store.transitionToSpawnStarted("missing_id", "somehash");
    expect(result).toEqual({ ok: false, error: "intent_not_found" });
  });

  it("transitions spawn_call_started to accepted on confirm", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("accepted");
      expect(result.intent.openclawRunId).toBe("run_1");
      expect(result.idempotent).toBe(false);
    }
  });

  it("transitions spawn_call_started to failed on confirmFailed", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmFailed(intent.spawnIntentId, "spawn_error");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("failed");
      expect(result.intent.error).toBe("spawn_error");
    }
  });
});

describe("NativeSpawnIntentStore duplicate confirm idempotent", () => {
  it("returns idempotent success for same runId confirm", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idempotent).toBe(true);
  });

  it("does not mutate intent on idempotent confirm", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });
    const confirmedAtBefore = intent.confirmedAt;

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });

    expect(intent.confirmedAt).toBe(confirmedAtBefore);
    expect(intent.openclawRunId).toBe("run_1");
  });
});

describe("NativeSpawnIntentStore conflict on different runId", () => {
  it("returns conflict when accepted intent is confirmed with different runId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_2" });

    expect(result).toMatchObject({ ok: false, error: "runId_conflict" });
  });

  it("preserves original openclawRunId on conflict", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_2" });

    expect(intent.openclawRunId).toBe("run_1");
  });

  it("returns existingRunId in conflict result", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "run_2" });

    expect(result).toEqual({ ok: false, error: "runId_conflict", existingRunId: "run_1" });
  });
});

describe("NativeSpawnIntentStore args hash mismatch", () => {
  it("stores hash that differs for tampered args", () => {
    const store = createStore();
    const intent = createIntent(store);
    const tamperedArgs = { ...baseArgs, task: "tampered task" };

    expect(computePlanHash(tamperedArgs)).not.toBe(intent.planHash);
  });

  it("rejects transition when args hash differs from planHash", () => {
    const store = createStore();
    const intent = createIntent(store);
    const tamperedHash = computePlanHash({ ...baseArgs, task: "tampered task" });

    const result = store.transitionToSpawnStarted(intent.spawnIntentId, tamperedHash);
    expect(result).toEqual({ ok: false, error: "args_hash_mismatch" });
  });
});

describe("NativeSpawnIntentStore edge cases", () => {
  it("rejects confirm with empty runId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_1", runId: "  " });
    expect(result).toEqual({ ok: false, error: "runId_required" });
  });

  it("rejects confirm for not-found intent", () => {
    const result = createStore().confirmAccept({ spawnIntentId: "missing", workContractId: "wc_1", runId: "run_1" });
    expect(result).toEqual({ ok: false, error: "intent_not_found" });
  });

  it("rejects confirm for wrong workContractId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, workContractId: "wc_WRONG", runId: "run_1" });
    expect(result).toEqual({ ok: false, error: "work_contract_mismatch" });
  });

  it("findPendingForSession returns latest non-expired planned intent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const now = Date.now();
    const first = store.create({ workContractId: "wc_1", sessionKey: "s1", sessionsSpawnArgs: baseArgs, ttlMs: 200, now });

    const second = store.create({ workContractId: "wc_2", sessionKey: "s1", sessionsSpawnArgs: baseArgs, ttlMs: 200, now: now + 1 });

    store.create({ workContractId: "wc_3", sessionKey: "other", sessionsSpawnArgs: baseArgs, ttlMs: 200, now: now + 2 });

    store.transitionToSpawnStarted(second.spawnIntentId, second.planHash);
    expect(store.findPendingForSession("s1", now + 3)).toBe(first);
  });

  it("findPendingForSession returns undefined when no planned intent", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash);
    expect(store.findPendingForSession("parent_session_1")).toBeUndefined();
  });

  it("clear resets store", () => {
    const store = createStore();
    createIntent(store);
    createIntent(store);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
