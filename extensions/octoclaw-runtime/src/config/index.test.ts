import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OCTOCLAW_RUNTIME_CONFIG,
  DEFAULT_SPAWN_INTENT_TTL_MS,
  isPlannerAllowedForSession,
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

describe("resolvePlannerSpawnConfig", () => {
  it("returns all defaults when no env is set", () => {
    expect(resolvePlannerSpawnConfig()).toEqual({
      spawnBackend: "planner",
      plannerAllowlist: [],
      intentTtlMs: DEFAULT_SPAWN_INTENT_TTL_MS,
    });
  });

  it("properly composes all individual resolvers", () => {
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    process.env.OCTOCLAW_PLANNER_ALLOWLIST = "ws1, ws_*";
    process.env.OCTOCLAW_SPAWN_INTENT_TTL_MS = "120000";

    expect(resolvePlannerSpawnConfig()).toEqual({
      spawnBackend: "planner",
      plannerAllowlist: ["ws1", "ws_*"],
      intentTtlMs: 120000,
    });
  });
});

describe("runtime convergence target invariants (WP-A)", () => {
  it.todo("WP-A gap: child finalizer recovery should not run in planner backend by default");

  it("keeps planner spawn config free of legacy runtime ledger mode (P6-001)", () => {
    expect(resolvePlannerSpawnConfig()).not.toHaveProperty("legacyRuntimeLedgerMode");
  });
});
