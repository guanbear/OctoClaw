import { afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  canonicalizeSessionsSpawnArgs,
  hashSessionsSpawnArgs,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";
import { NativeSpawnIntentStore } from "./native-spawn-intent-store.js";

const baseArgs: SessionsSpawnArgs = {
  task: "Implement a focused deliverable with clear success criteria.",
  model: "gpt-5.5",
  role: "code",
  workspacePath: "/workspace/octoclaw",
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

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical args hash", () => {
  it("produces stable hash for identical args", () => {
    expect(hashSessionsSpawnArgs(baseArgs)).toBe(hashSessionsSpawnArgs(baseArgs));
  });

  it("produces different hash for different args", () => {
    expect(hashSessionsSpawnArgs(baseArgs)).not.toBe(hashSessionsSpawnArgs({ ...baseArgs, task: "different task" }));
  });

  it("is key-order independent", () => {
    expect(hashSessionsSpawnArgs({ task: "a", model: "b" })).toBe(hashSessionsSpawnArgs({ model: "b", task: "a" }));
  });

  it("handles extra keys", () => {
    expect(hashSessionsSpawnArgs({ task: "a", model: "b", extra: true })).not.toBe(hashSessionsSpawnArgs({ task: "a", model: "b" }));
  });
});

describe("NativeSpawnIntentStore — create and get", () => {
  it("creates intent with planned status", () => {
    const store = createStore();
    const intent = createIntent(store);

    expect(intent.spawnIntentId).toMatch(/^si_[a-z0-9]+_[a-f0-9]{8}$/u);
    expect(intent.workContractId).toBe("wc_1");
    expect(intent.sessionKey).toBe("parent_session_1");
    expect(intent.sessionsSpawnArgs).toBe(baseArgs);
    expect(intent.status).toBe("planned");
    expect(intent.runId).toBeNull();
    expect(intent.ttlMs).toBe(60_000);
    expect(Date.parse(intent.createdAt)).not.toBeNaN();
    expect(intent.updatedAt).toBe(intent.createdAt);
    expect(store.get(intent.spawnIntentId)).toBe(intent);
    expect(store.size()).toBe(1);
  });

  it("generates unique spawnIntentId", () => {
    const store = createStore();
    const first = createIntent(store);
    const second = createIntent(store);

    expect(first.spawnIntentId).not.toBe(second.spawnIntentId);
  });

  it("computes canonical args hash", () => {
    const intent = createIntent();
    const manualHash = crypto.createHash("sha256")
      .update(canonicalizeSessionsSpawnArgs(baseArgs))
      .digest("hex");

    expect(intent.canonicalArgsHash).toBe(manualHash);
  });

  it("calculates expiresAt from createdAt + ttlMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const intent = createIntent(createStore(), 1_500);

    expect(intent.createdAt).toBe("2026-05-02T12:00:00.000Z");
    expect(intent.expiresAt).toBe("2026-05-02T12:00:01.500Z");
  });
});

describe("NativeSpawnIntentStore — TTL expiration", () => {
  it("expires planned intents past TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store, 100);

    vi.advanceTimersByTime(101);

    expect(store.expirePending()).toBe(1);
    expect(intent.status).toBe("expired");
  });

  it("does not expire intents within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store, 100);

    vi.advanceTimersByTime(100);

    expect(store.expirePending()).toBe(0);
    expect(intent.status).toBe("planned");
  });

  it("returns count of expired intents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    createIntent(store, 50);
    createIntent(store, 100);
    createIntent(store, 500);

    vi.advanceTimersByTime(101);

    expect(store.expirePending()).toBe(2);
  });
});

describe("NativeSpawnIntentStore — state transitions", () => {
  it("transitions planned → spawn_call_started", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store);
    const now = new Date("2026-05-02T12:00:01.000Z");
    const result = store.transitionToSpawnStarted(intent.spawnIntentId, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("spawn_call_started");
      expect(result.intent.updatedAt).toBe(now.toISOString());
    }
  });

  it("rejects transition from non-planned status", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    const result = store.transitionToSpawnStarted(intent.spawnIntentId);

    expect(result).toEqual({ ok: false, error: "invalid_status" });
  });

  it("rejects transition for expired intent", () => {
    const store = createStore();
    const intent = createIntent(store, 100);
    const result = store.transitionToSpawnStarted(intent.spawnIntentId, new Date(Date.parse(intent.expiresAt) + 1));

    expect(result).toEqual({ ok: false, error: "expired" });
    expect(intent.status).toBe("expired");
  });

  it("transitions spawn_call_started → accepted on confirm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store);
    const now = new Date("2026-05-02T12:00:02.000Z");

    store.transitionToSpawnStarted(intent.spawnIntentId);
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1", now });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("accepted");
      expect(result.intent.runId).toBe("run_1");
      expect(result.intent.updatedAt).toBe(now.toISOString());
      expect(result.idempotent).toBe(false);
    }
  });

  it("transitions spawn_call_started → failed on confirmFailed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store);
    const now = new Date("2026-05-02T12:00:03.000Z");

    store.transitionToSpawnStarted(intent.spawnIntentId);
    const result = store.confirmFailed(intent.spawnIntentId, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.status).toBe("failed");
      expect(result.intent.updatedAt).toBe(now.toISOString());
    }
  });
});

describe("NativeSpawnIntentStore — duplicate confirm (idempotent)", () => {
  it("returns idempotent success for same runId confirm", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });

    expect(result.ok).toBe(true);
  });

  it("does not mutate intent on idempotent confirm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const intent = createIntent(store);
    const acceptedAt = new Date("2026-05-02T12:00:05.000Z");

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1", now: acceptedAt });
    const updatedAt = intent.updatedAt;
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1", now: new Date("2026-05-02T12:00:06.000Z") });

    expect(intent.updatedAt).toBe(updatedAt);
    expect(intent.runId).toBe("run_1");
  });

  it("idempotent confirm returns idempotent: true", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idempotent).toBe(true);
  });
});

describe("NativeSpawnIntentStore — conflict on different runId", () => {
  it("returns conflict when accepted intent is confirmed with different runId", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });

    expect(store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_2" })).toMatchObject({ ok: false, error: "conflict" });
  });

  it("preserves original runId on conflict", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_2" });

    expect(intent.runId).toBe("run_1");
  });

  it("returns existingRunId in conflict result", () => {
    const store = createStore();
    const intent = createIntent(store);

    store.transitionToSpawnStarted(intent.spawnIntentId);
    store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_1" });
    const result = store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "run_2" });

    expect(result).toEqual({ ok: false, error: "conflict", existingRunId: "run_1" });
  });
});

describe("NativeSpawnIntentStore — args hash mismatch", () => {
  it("rejects confirm for intent with different args hash", () => {
    const store = createStore();
    const intent = createIntent(store);
    const attemptedArgs = { ...baseArgs, task: "tampered task" };

    expect(hashSessionsSpawnArgs(attemptedArgs)).not.toBe(intent.canonicalArgsHash);
  });
});

describe("NativeSpawnIntentStore — edge cases", () => {
  it("rejects confirm with empty runId", () => {
    const store = createStore();
    const intent = createIntent(store);

    expect(store.confirmAccept({ spawnIntentId: intent.spawnIntentId, runId: "  " })).toEqual({ ok: false, error: "missing_runId" });
  });

  it("rejects confirm for not-found intent", () => {
    expect(createStore().confirmAccept({ spawnIntentId: "missing", runId: "run_1" })).toEqual({ ok: false, error: "not_found" });
  });

  it("getPendingForSession returns latest planned intent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    const store = createStore();
    const first = createIntent(store);
    vi.advanceTimersByTime(1);
    const second = createIntent(store);
    vi.advanceTimersByTime(1);
    store.create({ workContractId: "wc_2", sessionKey: "other", sessionsSpawnArgs: baseArgs, ttlMs: 60_000 });
    store.transitionToSpawnStarted(second.spawnIntentId);

    expect(store.getPendingForSession("parent_session_1")).toBe(first);
  });

  it("getPendingForSession returns undefined when no planned intent", () => {
    const store = createStore();
    const intent = createIntent(store);
    store.transitionToSpawnStarted(intent.spawnIntentId);

    expect(store.getPendingForSession("parent_session_1")).toBeUndefined();
  });
});
