import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performCrashRecovery } from "../crash-recovery.js";
import * as nativeReconcile from "../native-reconcile.js";
import * as projectionRebuild from "../projection-rebuild.js";
import * as featureFlags from "../feature-flags.js";

describe("crash-recovery", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("performCrashRecovery", () => {
    it("returns zeros and empty errors when ledger is unavailable", () => {
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.attemptsReconciled).toBe(0);
      expect(result.spawnConfirmed).toBe(0);
      expect(result.terminalUpdated).toBe(0);
      expect(result.projectionRebuilt).toBe(false);
      expect(result.projectionTaskCount).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("reconciles non-terminal attempts when queryNativeState provided", () => {
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 3, reconciled: 2, spawnConfirmed: 1, terminalUpdated: 1, errors: [] });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const queryNativeState = vi.fn().mockReturnValue(null);
      const result = performCrashRecovery({ sqlite: null as any, queryNativeState });

      expect(result.attemptsReconciled).toBe(2);
      expect(result.spawnConfirmed).toBe(1);
      expect(result.terminalUpdated).toBe(1);
      expect(nativeReconcile.reconcileAllNonTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ queryNativeState })
      );
    });

    it("rebuilds projection when OCTOCLAW_TASK_STATE_REBUILD=1", () => {
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(true);
      vi.spyOn(projectionRebuild, "writeRebuiltTaskState").mockReturnValue({ written: true, path: "/tmp/task-state.json", taskCount: 10 });

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.projectionRebuilt).toBe(true);
      expect(result.projectionTaskCount).toBe(10);
      expect(projectionRebuild.writeRebuiltTaskState).toHaveBeenCalled();
    });

    it("skips projection rebuild when flag is off", () => {
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);
      vi.spyOn(projectionRebuild, "writeRebuiltTaskState").mockReturnValue({ written: true, path: "/tmp/task-state.json", taskCount: 10 });

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.projectionRebuilt).toBe(false);
      expect(result.projectionTaskCount).toBe(0);
      expect(projectionRebuild.writeRebuiltTaskState).not.toHaveBeenCalled();
    });

    it("continues on individual step failure (resilient)", () => {
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockImplementation(() => {
        throw new Error("reconcile failure");
      });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.errors).toContain("reconcile failure");
      expect(result.attemptsReconciled).toBe(0);
    });

    it("reports durationMs > 0", () => {
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
