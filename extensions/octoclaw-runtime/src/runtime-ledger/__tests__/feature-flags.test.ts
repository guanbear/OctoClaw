import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRuntimeLedgerFlag, isLedgerActive, resolveAllFeatureFlags } from "../feature-flags.js";

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

  describe("resolveAllFeatureFlags", () => {
    it("aggregates ledger flags", () => {
      delete process.env.OCTOCLAW_RUNTIME_LEDGER;

      const flags = resolveAllFeatureFlags();
      expect(flags).toEqual({
        ledgerMode: "enforce",
        ledgerActive: true,
      });
    });

    it("reflects shadow mode", () => {
      process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";

      const flags = resolveAllFeatureFlags();
      expect(flags.ledgerMode).toBe("shadow");
      expect(flags.ledgerActive).toBe(true);
    });
  });
});
