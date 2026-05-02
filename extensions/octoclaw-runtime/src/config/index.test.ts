import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OCTOCLAW_RUNTIME_CONFIG,
  DEFAULT_SPAWN_INTENT_TTL_MS,
  isPlannerAllowedForSession,
  resolveLegacyChildFinalizerDisabled,
  resolveLegacyCompletionFileEnabled,
  resolveLegacyDeliveryOutboxDisabled,
  resolveLegacyRuntimeLedgerMode,
  resolvePlannerAllowlist,
  resolvePlannerSpawnConfig,
  resolveRuntimeConfig,
  resolveSpawnBackend,
  resolveSpawnIntentTtlMs,
} from "./index.js";


const ENV_KEYS = [
  "OCTOCLAW_SPAWN_BACKEND",
  "OCTOCLAW_PLANNER_ALLOWLIST",
  "OCTOCLAW_SPAWN_INTENT_TTL_MS",
  "OCTOCLAW_LEGACY_COMPLETION_FILE",
  "OCTOCLAW_DISABLE_CHILD_FINALIZER",
  "OCTOCLAW_DISABLE_DELIVERY_OUTBOX",
  "OCTOCLAW_LEGACY_RUNTIME_LEDGER",
] as const;

let originalEnv: typeof process.env;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.env = originalEnv;
});

describe("runtime config", () => {
  it("loads and validates runtime policy settings", () => {
    const config = resolveRuntimeConfig({
      defaultChannel: "slack",
      defaultNotifyPolicy: "default",
      defaultRuntime: "subagent",
    });

    expect(config).toEqual({
      defaultChannel: "slack",
      defaultNotifyPolicy: "default",
      defaultRuntime: "subagent",
    });
  });

  it("uses correct default values", () => {
    expect(DEFAULT_OCTOCLAW_RUNTIME_CONFIG).toEqual({
      defaultChannel: "direct",
      defaultNotifyPolicy: "silent",
      defaultRuntime: "subagent",
    });
    expect(resolveRuntimeConfig()).toEqual(DEFAULT_OCTOCLAW_RUNTIME_CONFIG);
  });
});


describe("planner spawn config", () => {
  it("defaults to legacy backend", () => {
    expect(resolveSpawnBackend()).toBe("legacy");
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    expect(resolveSpawnBackend()).toBe("planner");
    process.env.OCTOCLAW_SPAWN_BACKEND = "off";
    expect(resolveSpawnBackend()).toBe("off");
    process.env.OCTOCLAW_SPAWN_BACKEND = "invalid";
    expect(resolveSpawnBackend()).toBe("legacy");
  });

  it("parses planner allowlist with exact, wildcard, and global matches", () => {
    expect(resolvePlannerAllowlist()).toEqual([]);
    expect(isPlannerAllowedForSession("session-any")).toBe(true);
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:*, exact-session";
    expect(resolvePlannerAllowlist()).toEqual(["agent:main:*", "exact-session"]);
    expect(isPlannerAllowedForSession("agent:main:slack:thread-1")).toBe(true);
    expect(isPlannerAllowedForSession("exact-session")).toBe(true);
    expect(isPlannerAllowedForSession("other-session")).toBe(false);
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "*";
    expect(isPlannerAllowedForSession("other-session")).toBe(true);
  });

  it("bounds spawn intent ttl", () => {
    expect(resolveSpawnIntentTtlMs()).toBe(DEFAULT_SPAWN_INTENT_TTL_MS);
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "100";
    expect(resolveSpawnIntentTtlMs()).toBe(5_000);
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "999999";
    expect(resolveSpawnIntentTtlMs()).toBe(300_000);
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "120000";
    expect(resolveSpawnIntentTtlMs()).toBe(120_000);
  });

  it("parses legacy rollback flags", () => {
    expect(resolveLegacyCompletionFileEnabled()).toBe(false);
    expect(resolveLegacyChildFinalizerDisabled()).toBe(false);
    expect(resolveLegacyDeliveryOutboxDisabled()).toBe(false);
    expect(resolveLegacyRuntimeLedgerMode()).toBe("on");
    process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "true";
    process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "1";
    process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "true";
    process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "read_only";
    expect(resolveLegacyCompletionFileEnabled()).toBe(true);
    expect(resolveLegacyChildFinalizerDisabled()).toBe(true);
    expect(resolveLegacyDeliveryOutboxDisabled()).toBe(true);
    expect(resolveLegacyRuntimeLedgerMode()).toBe("read_only");
    process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "off";
    expect(resolveLegacyRuntimeLedgerMode()).toBe("off");
  });

  it("composes planner spawn config", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "agent:main:*";
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "120000";
    process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "true";
    expect(resolvePlannerSpawnConfig()).toMatchObject({
      spawnBackend: "planner",
      plannerAllowlist: ["agent:main:*"],
      intentTtlMs: 120_000,
      legacyChildFinalizerDisabled: true,
      legacyRuntimeLedgerMode: "on",
    });
  });
});
