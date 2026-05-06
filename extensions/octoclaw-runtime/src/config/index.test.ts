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
  shouldRunChildFinalizerRecovery,
  shouldRunDeliveryOutboxFlush,
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
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
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

describe("resolveSpawnBackend", () => {
  it("returns planner when OCTOCLAW_SPAWN_BACKEND=planner", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    expect(resolveSpawnBackend()).toBe("planner");
  });

  it("returns legacy when OCTOCLAW_SPAWN_BACKEND=legacy", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    expect(resolveSpawnBackend()).toBe("legacy");
  });

  it("returns off when OCTOCLAW_SPAWN_BACKEND=off", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "off";
    expect(resolveSpawnBackend()).toBe("off");
  });

  it("defaults to planner when env is not set", () => {
    expect(resolveSpawnBackend()).toBe("planner");
  });

  it.each(["foo", "random", ""])("defaults to planner for invalid value %j", (value) => {
    process.env.OCTOCLAW_SPAWN_BACKEND = value;
    expect(resolveSpawnBackend()).toBe("planner");
  });
});

describe("resolvePlannerAllowlist", () => {
  it("returns empty array when env is not set", () => {
    expect(resolvePlannerAllowlist()).toEqual([]);
  });

  it("parses comma-separated values", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1,ws2,ws3";
    expect(resolvePlannerAllowlist()).toEqual(["ws1", "ws2", "ws3"]);
  });

  it("trims whitespace", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = " ws1 , ws2 , ws3 ";
    expect(resolvePlannerAllowlist()).toEqual(["ws1", "ws2", "ws3"]);
  });

  it("filters empty strings", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1,, ,ws2,";
    expect(resolvePlannerAllowlist()).toEqual(["ws1", "ws2"]);
  });
});

describe("isPlannerAllowedForSession", () => {
  it("returns true when allowlist is empty", () => {
    expect(isPlannerAllowedForSession("session-1")).toBe(true);
  });

  it("returns true for exact match", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1,ws2";
    expect(isPlannerAllowedForSession("ws2")).toBe(true);
  });

  it("returns true for wildcard prefix match", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws_*,team-a";
    expect(isPlannerAllowedForSession("ws_123")).toBe(true);
  });

  it("returns false for non-matching session", () => {
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1,ws_*";
    expect(isPlannerAllowedForSession("runner-1")).toBe(false);
  });
});

describe("resolveSpawnIntentTtlMs", () => {
  it("returns default when env is not set", () => {
    expect(resolveSpawnIntentTtlMs()).toBe(DEFAULT_SPAWN_INTENT_TTL_MS);
  });

  it("parses valid number", () => {
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "120000";
    expect(resolveSpawnIntentTtlMs()).toBe(120000);
  });

  it("returns default for non-numeric values", () => {
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "not-a-number";
    expect(resolveSpawnIntentTtlMs()).toBe(DEFAULT_SPAWN_INTENT_TTL_MS);
  });

  it("returns default for negative numbers", () => {
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "-100";
    expect(resolveSpawnIntentTtlMs()).toBe(DEFAULT_SPAWN_INTENT_TTL_MS);
  });

  it("floors at 5000 minimum", () => {
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "100";
    expect(resolveSpawnIntentTtlMs()).toBe(5000);
  });

  it("caps at 300000 maximum", () => {
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "999999";
    expect(resolveSpawnIntentTtlMs()).toBe(300000);
  });
});

describe("legacy disable flags", () => {
  describe("resolveLegacyCompletionFileEnabled", () => {
    it("defaults to false", () => {
      expect(resolveLegacyCompletionFileEnabled()).toBe(false);
    });

    it("returns true for 1", () => {
      process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "1";
      expect(resolveLegacyCompletionFileEnabled()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "true";
      expect(resolveLegacyCompletionFileEnabled()).toBe(false);
    });
  });

  describe("resolveLegacyChildFinalizerDisabled", () => {
    it("defaults to false", () => {
      expect(resolveLegacyChildFinalizerDisabled()).toBe(false);
    });

    it("returns true for 1", () => {
      process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "1";
      expect(resolveLegacyChildFinalizerDisabled()).toBe(true);
    });

    it("returns true for true", () => {
      process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "true";
      expect(resolveLegacyChildFinalizerDisabled()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "yes";
      expect(resolveLegacyChildFinalizerDisabled()).toBe(false);
    });
  });

  describe("resolveLegacyDeliveryOutboxDisabled", () => {
    it("defaults to false", () => {
      expect(resolveLegacyDeliveryOutboxDisabled()).toBe(false);
    });

    it("returns true for 1", () => {
      process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "1";
      expect(resolveLegacyDeliveryOutboxDisabled()).toBe(true);
    });

    it("returns true for true", () => {
      process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "true";
      expect(resolveLegacyDeliveryOutboxDisabled()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "yes";
      expect(resolveLegacyDeliveryOutboxDisabled()).toBe(false);
    });
  });

  describe("resolveLegacyRuntimeLedgerMode", () => {
    it("defaults to on", () => {
      expect(resolveLegacyRuntimeLedgerMode()).toBe("on");
    });

    it("returns read_only for read_only", () => {
      process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "read_only";
      expect(resolveLegacyRuntimeLedgerMode()).toBe("read_only");
    });

    it("returns off for off", () => {
      process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "off";
      expect(resolveLegacyRuntimeLedgerMode()).toBe("off");
    });

    it("returns on for invalid values", () => {
      process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "disabled";
      expect(resolveLegacyRuntimeLedgerMode()).toBe("on");
    });
  });
});

describe("resolvePlannerSpawnConfig", () => {
  it("returns all defaults when no env is set", () => {
    expect(resolvePlannerSpawnConfig()).toEqual({
      spawnBackend: "planner",
      plannerAllowlist: [],
      intentTtlMs: DEFAULT_SPAWN_INTENT_TTL_MS,
      legacyCompletionFileEnabled: false,
      legacyChildFinalizerDisabled: false,
      legacyDeliveryOutboxDisabled: false,
      legacyRuntimeLedgerMode: "on",
    });
  });

  it("properly composes all individual resolvers", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1, ws_*";
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "120000";
    process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "1";
    process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "true";
    process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "1";
    process.env.OCTOCLAW_LEGACY_RUNTIME_LEDGER = "read_only";

    expect(resolvePlannerSpawnConfig()).toEqual({
      spawnBackend: "planner",
      plannerAllowlist: ["ws1", "ws_*"],
      intentTtlMs: 120000,
      legacyCompletionFileEnabled: true,
      legacyChildFinalizerDisabled: true,
      legacyDeliveryOutboxDisabled: true,
      legacyRuntimeLedgerMode: "read_only",
    });
  });
});

describe("shouldRunChildFinalizerRecovery", () => {
  it("runs child finalizer recovery by default as native announce backstop", () => {
    expect(shouldRunChildFinalizerRecovery()).toBe(true);
  });

  it("runs in explicit legacy backend by default", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    expect(shouldRunChildFinalizerRecovery()).toBe(true);
  });

  it("runs in planner backend by default", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    expect(shouldRunChildFinalizerRecovery()).toBe(true);
  });

  it("runs in planner backend when legacy completion file is explicitly enabled", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "1";
    expect(shouldRunChildFinalizerRecovery()).toBe(true);
  });

  it("does not run in planner backend when child finalizer is explicitly disabled", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "1";
    expect(shouldRunChildFinalizerRecovery()).toBe(false);
  });

  it("does not run in legacy backend when child finalizer is explicitly disabled", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    process.env.OCTOCLAW_DISABLE_CHILD_FINALIZER = "1";
    expect(shouldRunChildFinalizerRecovery()).toBe(false);
  });

  it("does not run in off backend by default", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "off";
    expect(shouldRunChildFinalizerRecovery()).toBe(false);
  });
});

describe("shouldRunDeliveryOutboxFlush", () => {
  it("does not run delivery outbox by default", () => {
    expect(shouldRunDeliveryOutboxFlush()).toBe(false);
  });

  it("runs in explicit legacy backend by default", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    expect(shouldRunDeliveryOutboxFlush()).toBe(true);
  });

  it("does not run in planner backend by default", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    expect(shouldRunDeliveryOutboxFlush()).toBe(false);
  });

  it("runs in planner backend when both legacy completion file and outbox are enabled", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "1";
    expect(shouldRunDeliveryOutboxFlush()).toBe(true);
  });

  it("does not run in planner backend when delivery outbox is disabled even with completion file", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_LEGACY_COMPLETION_FILE = "1";
    process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "1";
    expect(shouldRunDeliveryOutboxFlush()).toBe(false);
  });

  it("does not run in legacy backend when delivery outbox is explicitly disabled", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    process.env.OCTOCLAW_DISABLE_DELIVERY_OUTBOX = "true";
    expect(shouldRunDeliveryOutboxFlush()).toBe(false);
  });

  it("does not run in off backend", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "off";
    expect(shouldRunDeliveryOutboxFlush()).toBe(false);
  });
});
