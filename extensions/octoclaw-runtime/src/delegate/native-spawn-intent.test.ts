import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSessionsSpawnArgs,
  computePlanHash,
  hashSessionsSpawnArgs,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";
import { NativeSpawnIntentStore } from "./native-spawn-intent-store.js";

const baseArgs: SessionsSpawnArgs = {
  task: "Implement a focused deliverable with clear success criteria.",
  model: "gpt-5.5",
  cwd: "/workspace/octoclaw",
};

const BASE_NOW = 1777723200000; // 2026-05-02T12:00:00.000Z

function createStore(): NativeSpawnIntentStore {
  return new NativeSpawnIntentStore();
}

function createIntent(store = createStore(), ttlMs = 60_000, now = BASE_NOW) {
  return store.create({
    workContractId: "wc_1",
    sessionKey: "parent_session_1",
    sessionsSpawnArgs: baseArgs,
    ttlMs,
    now,
  });
}

function advanceToSpawnStarted(
  store: NativeSpawnIntentStore,
  workContractId = "wc_1",
  sessionKey = "parent_session_1",
  now = BASE_NOW,
) {
  const intent = store.create({
    workContractId,
    sessionKey,
    sessionsSpawnArgs: baseArgs,
    ttlMs: 60_000,
    now,
  });
  const result = store.transitionToSpawnStarted(
    intent.spawnIntentId,
    intent.planHash,
    now,
  );
  if (!result.ok) throw new Error(`advanceToSpawnStarted failed: ${result.error}`);
  return intent;
}

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
    const expected = crypto
      .createHash("sha256")
      .update(canonical)
      .digest("hex");
    expect(computePlanHash(baseArgs)).toBe(expected);
  });

  it("deprecated hashSessionsSpawnArgs is an alias for computePlanHash", () => {
    expect(hashSessionsSpawnArgs(baseArgs)).toBe(computePlanHash(baseArgs));
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
    const second = createIntent(store, 60_000, BASE_NOW + 1);
    expect(first.spawnIntentId).not.toBe(second.spawnIntentId);
  });

  it("computes planHash from canonical args", () => {
    const intent = createIntent();
    const manualHash = crypto
      .createHash("sha256")
      .update(canonicalizeSessionsSpawnArgs(baseArgs))
      .digest("hex");
    expect(intent.planHash).toBe(manualHash);
  });

  it("calculates expiresAt from createdAt + ttlMs", () => {
    const store = createStore();
    const intent = store.create({
      workContractId: "wc_1",
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 1_500,
      now: BASE_NOW,
    });
    expect(intent.createdAt).toBe(BASE_NOW);
    expect(intent.expiresAt).toBe(BASE_NOW + 1_500);
  });
});

describe("NativeSpawnIntentStore TTL expiration", () => {
  it("expires planned intents past TTL", () => {
    const store = createStore();
    const intent = createIntent(store, 100, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 101)).toBe(1);
    expect(intent.status).toBe("expired");
  });

  it("does not expire intents within TTL", () => {
    const store = createStore();
    createIntent(store, 100, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 100)).toBe(0);
  });

  it("returns count of expired intents", () => {
    const store = createStore();
    createIntent(store, 50, BASE_NOW);
    createIntent(store, 100, BASE_NOW);
    createIntent(store, 500, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 101)).toBe(2);
  });

  it("expires spawn_call_started intents past TTL", () => {
    const store = createStore();
    const short = store.create({
      workContractId: "wc_1",
      sessionKey: "s1",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 50,
      now: BASE_NOW,
    });
    store.transitionToSpawnStarted(short.spawnIntentId, short.planHash, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 51)).toBe(1);
    expect(short.status).toBe("expired");
  });
});

describe("NativeSpawnIntentStore state transitions", () => {
  it("transitions planned to spawn_call_started with matching hash", () => {
    const store = createStore();
    const intent = createIntent(store);
    const result = store.transitionToSpawnStarted(
      intent.spawnIntentId,
      intent.planHash,
      BASE_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("spawn_call_started");
    }
  });

  it("rejects transition with args hash mismatch", () => {
    const store = createStore();
    const intent = createIntent(store);
    const tamperedHash = computePlanHash({ ...baseArgs, task: "tampered task" });
    const result = store.transitionToSpawnStarted(
      intent.spawnIntentId,
      tamperedHash,
      BASE_NOW,
    );
    expect(result).toEqual({ ok: false, error: "args_hash_mismatch" });
  });

  it("rejects transition from non-planned status", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash, BASE_NOW);
    const result = store.transitionToSpawnStarted(
      intent.spawnIntentId,
      intent.planHash,
      BASE_NOW,
    );
    expect(result).toEqual({ ok: false, error: "invalid_status" });
  });

  it("rejects transition for expired intent", () => {
    const store = createStore();
    const intent = createIntent(store, 100, BASE_NOW);
    const result = store.transitionToSpawnStarted(
      intent.spawnIntentId,
      intent.planHash,
      BASE_NOW + 101,
    );
    expect(result).toEqual({ ok: false, error: "intent_expired" });
    expect(intent.status).toBe("expired");
  });

  it("rejects transition for not-found intent", () => {
    const store = createStore();
    const result = store.transitionToSpawnStarted("missing_id", "somehash", BASE_NOW);
    expect(result).toEqual({ ok: false, error: "intent_not_found" });
  });

  it("transitions spawn_call_started to accepted on confirm", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const confirmNow = BASE_NOW + 2_000;
    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: confirmNow,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("accepted");
      expect(result.intent.openclawRunId).toBe("run_1");
      expect(result.intent.confirmedAt).toBe(confirmNow);
      expect(result.idempotent).toBe(false);
    }
  });

  it("transitions planned directly to accepted on confirm without spawn_call_started", () => {
    const store = createStore();
    const intent = createIntent(store);

    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("accepted");
      expect(result.intent.openclawRunId).toBe("run_1");
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

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });
    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW + 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idempotent).toBe(true);
  });

  it("does not mutate intent on idempotent confirm", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });
    const confirmedAtBefore = intent.confirmedAt;

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW + 1,
    });

    expect(intent.confirmedAt).toBe(confirmedAtBefore);
    expect(intent.openclawRunId).toBe("run_1");
  });
});

describe("NativeSpawnIntentStore conflict on different runId", () => {
  it("returns conflict when accepted intent is confirmed with different runId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });
    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_2",
      now: BASE_NOW,
    });

    expect(result).toMatchObject({ ok: false, error: "runId_conflict" });
  });

  it("preserves original openclawRunId on conflict", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });
    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_2",
      now: BASE_NOW,
    });

    expect(intent.openclawRunId).toBe("run_1");
  });

  it("returns existingRunId in conflict result", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });
    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_2",
      now: BASE_NOW,
    });

    expect(result).toEqual({
      ok: false,
      error: "runId_conflict",
      existingRunId: "run_1",
    });
  });
});

describe("NativeSpawnIntentStore edge cases", () => {
  it("rejects confirm with empty runId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "  ",
    });
    expect(result).toEqual({ ok: false, error: "runId_required" });
  });

  it("rejects confirm for not-found intent", () => {
    const result = createStore().confirmAccept({
      spawnIntentId: "missing",
      workContractId: "wc_1",
      runId: "run_1",
    });
    expect(result).toEqual({ ok: false, error: "intent_not_found" });
  });

  it("rejects confirm with wrong workContractId", () => {
    const store = createStore();
    const intent = advanceToSpawnStarted(store);

    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_WRONG",
      runId: "run_1",
    });
    expect(result).toEqual({ ok: false, error: "work_contract_mismatch" });
  });

  it("findPendingForSession returns latest non-expired planned intent", () => {
    const store = createStore();
    const first = store.create({
      workContractId: "wc_1",
      sessionKey: "s1",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 200,
      now: BASE_NOW,
    });
    const second = store.create({
      workContractId: "wc_2",
      sessionKey: "s1",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 200,
      now: BASE_NOW + 1,
    });
    store.create({
      workContractId: "wc_3",
      sessionKey: "other",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 200,
      now: BASE_NOW + 2,
    });
    store.transitionToSpawnStarted(second.spawnIntentId, second.planHash, BASE_NOW + 2);
    expect(store.findPendingForSession("s1", BASE_NOW + 3)).toBe(first);
  });

  it("findPendingForSession auto-expires stale planned intents", () => {
    const store = createStore();
    store.create({
      workContractId: "wc_1",
      sessionKey: "s1",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 50,
      now: BASE_NOW,
    });
    expect(store.findPendingForSession("s1", BASE_NOW + 51)).toBeUndefined();
  });

  it("findPendingForSession returns undefined when no planned intent", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnStarted(intent.spawnIntentId, intent.planHash, BASE_NOW);
    expect(store.findPendingForSession("parent_session_1")).toBeUndefined();
  });

  it("clear resets store", () => {
    const store = createStore();
    createIntent(store);
    createIntent(store, 60_000, BASE_NOW + 1);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
