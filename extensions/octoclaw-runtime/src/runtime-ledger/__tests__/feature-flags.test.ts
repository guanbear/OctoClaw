import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRuntimeLedgerFlag, isLedgerActive, isSchedulerEnabled, isTaskStateRebuildEnabled, resolveAllFeatureFlags } from "../feature-flags.js";

describe("feature-flags", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveRuntimeLedgerFlag", () => {
    it("returns enforce by default", () => {
      delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      expect(resolveRuntimeLedgerFlag()).toBe("enforce");
    });

    it("returns shadow when set", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
      expect(resolveRuntimeLedgerFlag()).toBe("shadow");
    });

    it("returns enforce when set", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
      expect(resolveRuntimeLedgerFlag()).toBe("enforce");
    });

    it("returns off when explicitly set", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
      expect(resolveRuntimeLedgerFlag()).toBe("off");
    });

    it("is case insensitive", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "SHADOW";
      expect(resolveRuntimeLedgerFlag()).toBe("shadow");
    });

    it("trims whitespace", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = " enforce ";
      expect(resolveRuntimeLedgerFlag()).toBe("enforce");
    });

    it("returns enforce for unknown value", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "debug";
      expect(resolveRuntimeLedgerFlag()).toBe("enforce");
    });

    it("defaults to runtime ledger enforce mode", () => {
      delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      expect(resolveRuntimeLedgerFlag()).toBe("enforce");
      expect(isLedgerActive()).toBe(true);
    });
  });

  describe("isLedgerActive", () => {
    it("returns true for shadow", () => {
      expect(isLedgerActive("shadow")).toBe(true);
    });

    it("returns true for enforce", () => {
      expect(isLedgerActive("enforce")).toBe(true);
    });

    it("returns false for off", () => {
      expect(isLedgerActive("off")).toBe(false);
    });
  });

  describe("isSchedulerEnabled", () => {
    it("returns false by default", () => {
      delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
      expect(isSchedulerEnabled()).toBe(false);
    });

    it("returns true when set to 1", () => {
      process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
      expect(isSchedulerEnabled()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env.OCTOCLAW_SCHEDULER_ENABLED = "yes";
      expect(isSchedulerEnabled()).toBe(false);
    });
  });

  describe("isTaskStateRebuildEnabled", () => {
    it("returns true by default", () => {
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
      expect(isTaskStateRebuildEnabled()).toBe(true);
    });

    it("returns true when set to 1", () => {
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";
      expect(isTaskStateRebuildEnabled()).toBe(true);
    });

    it("returns false when explicitly disabled", () => {
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "0";
      expect(isTaskStateRebuildEnabled()).toBe(false);

      process.env.OCTOCLAW_TASK_STATE_REBUILD = "false";
      expect(isTaskStateRebuildEnabled()).toBe(false);
    });

    it("defaults to enabled task-state rebuild", () => {
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
      expect(isTaskStateRebuildEnabled()).toBe(true);
    });
  });

  describe("resolveAllFeatureFlags", () => {
    it("aggregates all flags", () => {
      delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;

      const flags = resolveAllFeatureFlags();
      expect(flags).toEqual({
        ledgerMode: "enforce",
        ledgerActive: true,
        schedulerEnabled: false,
        taskStateRebuildEnabled: true,
      });
    });

    it("reflects enabled flags", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
      process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";

      const flags = resolveAllFeatureFlags();
      expect(flags.ledgerMode).toBe("enforce");
      expect(flags.ledgerActive).toBe(true);
      expect(flags.schedulerEnabled).toBe(true);
      expect(flags.taskStateRebuildEnabled).toBe(true);
    });
  });
});
