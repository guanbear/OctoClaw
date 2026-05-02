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
  context: "isolated",
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
  const result = store.transitionToSpawnCallStarted({
    spawnIntentId: intent.spawnIntentId,
    sessionKey,
    sessionsSpawnArgs: baseArgs,
    now,
  });
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
    expect(computePlanHash({ task: "a", model: "b", thinking: "medium" })).not.toBe(
      computePlanHash({ task: "a", model: "b" }),
    );
  });

  it("includes isolated context in the canonical args hash", () => {
    expect(canonicalizeSessionsSpawnArgs({ task: "a", context: "isolated" })).toContain('"context":"isolated"');
    expect(computePlanHash({ task: "a", context: "isolated" })).not.toBe(
      computePlanHash({ task: "a" }),
    );
  });

  it("ignores OpenClaw default/enrichment fields that do not change the plan", () => {
    expect(computePlanHash({ task: "a", runtime: "subagent", timeoutSeconds: 0, attachments: [] })).toBe(
      computePlanHash({ task: "a" }),
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
    expect(intent.sessionsSpawnArgs).toEqual(baseArgs);
    expect(intent.status).toBe("planned");
    expect(intent.openclawRunId).toBeUndefined();
    expect(new Date(intent.createdAt).getTime()).toBe(BASE_NOW);
    expect(new Date(intent.expiresAt).getTime()).toBe(BASE_NOW + 60_000);
    expect(store.get(intent.spawnIntentId)).toEqual(intent);
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
    expect(intent.createdAt).toBe(new Date(BASE_NOW).toISOString());
    expect(intent.expiresAt).toBe(new Date(BASE_NOW + 1_500).toISOString());
  });
});

describe("NativeSpawnIntentStore TTL expiration", () => {
  it("expires planned intents past TTL", () => {
    const store = createStore();
    const intent = createIntent(store, 100, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 101)).toBe(1);
    expect(store.get(intent.spawnIntentId)?.status).toBe("expired");
  });

  it("does not expire intents within TTL", () => {
    const store = createStore();
    createIntent(store, 100, BASE_NOW);
    expect(store.expireElapsed(BASE_NOW + 99)).toBe(0);
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
    store.transitionToSpawnCallStarted({ spawnIntentId: short.spawnIntentId, sessionKey: "s1", sessionsSpawnArgs: baseArgs, now: BASE_NOW });
    expect(store.expireElapsed(BASE_NOW + 51)).toBe(1);
    expect(store.get(short.spawnIntentId)?.status).toBe("expired");
  });
});

describe("NativeSpawnIntentStore state transitions", () => {
  it("transitions planned to spawn_call_started with matching hash", () => {
    const store = createStore();
    const intent = createIntent(store);
    const result = store.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: baseArgs,
      now: BASE_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("spawn_call_started");
    }
  });

  it("rejects transition with args hash mismatch", () => {
    const store = createStore();
    const intent = createIntent(store);
    const result = store.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: { ...baseArgs, task: "tampered task" },
      now: BASE_NOW,
    });
    expect(result).toMatchObject({ ok: false, error: "args_hash_mismatch" });
  });

  it("rejects transition from non-planned status", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnCallStarted({ spawnIntentId: intent.spawnIntentId, sessionKey: "parent_session_1", sessionsSpawnArgs: baseArgs, now: BASE_NOW });
    const result = store.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: baseArgs,
      now: BASE_NOW,
    });
    expect(result).toMatchObject({ ok: false, error: "invalid_status:spawn_call_started" });
  });

  it("rejects transition for expired intent", () => {
    const store = createStore();
    const intent = createIntent(store, 100, BASE_NOW);
    const result = store.transitionToSpawnCallStarted({
      spawnIntentId: intent.spawnIntentId,
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: baseArgs,
      now: BASE_NOW + 101,
    });
    expect(result).toMatchObject({ ok: false, error: "intent_expired" });
    expect(store.get(intent.spawnIntentId)?.status).toBe("expired");
  });

  it("rejects transition for not-found intent", () => {
    const store = createStore();
    const result = store.transitionToSpawnCallStarted({
      spawnIntentId: "missing_id",
      sessionKey: "parent_session_1",
      sessionsSpawnArgs: baseArgs,
      now: BASE_NOW,
    });
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
      expect(result.intent.confirmedAt).toBe(new Date(confirmNow).toISOString());
      expect(result.idempotent).toBe(false);
    }
  });

  it("rejects planned directly to accepted on confirm without spawn_call_started", () => {
    const store = createStore();
    const intent = createIntent(store);

    const result = store.confirmAccept({
      spawnIntentId: intent.spawnIntentId,
      workContractId: "wc_1",
      runId: "run_1",
      now: BASE_NOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_status:planned" });
    expect(intent.status).toBe("planned");
  });

  it("does not rewrite expired intent to failed", () => {
    const store = createStore();
    const intent = store.create({
      workContractId: "wc_expired_failed",
      sessionKey: "session-expired-failed",
      sessionsSpawnArgs: baseArgs,
      ttlMs: 10,
      now: BASE_NOW,
    });
    store.expireElapsed(BASE_NOW + 11);

    const result = store.confirmFailed(intent.spawnIntentId, "spawn_error_after_expiry");

    expect(result).toMatchObject({ ok: false, error: "already_terminal" });
    expect(store.get(intent.spawnIntentId)?.status).toBe("expired");
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
    expect(store.get(intent.spawnIntentId)?.openclawRunId).toBe("run_1");
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

    expect(store.get(intent.spawnIntentId)?.openclawRunId).toBe("run_1");
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
    store.transitionToSpawnCallStarted({ spawnIntentId: second.spawnIntentId, sessionKey: "s1", sessionsSpawnArgs: baseArgs, now: BASE_NOW + 2 });
    expect(store.findPendingForSession("s1", BASE_NOW + 3)).toEqual(first);
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
    expect(store.findPendingForSession("s1", BASE_NOW + 51)).toBeNull();
  });

  it("findPendingForSession returns undefined when no planned intent", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnCallStarted({ spawnIntentId: intent.spawnIntentId, sessionKey: "parent_session_1", sessionsSpawnArgs: baseArgs, now: BASE_NOW });
    expect(store.findPendingForSession("parent_session_1")).toBeNull();
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
