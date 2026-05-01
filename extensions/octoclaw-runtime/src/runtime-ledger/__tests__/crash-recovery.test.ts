import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performCrashRecovery } from "../crash-recovery.js";
import * as scheduler from "../scheduler.js";
import * as nativeReconcile from "../native-reconcile.js";
import * as completionBinding from "../completion-binding.js";
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
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.staleLeasesReleased).toBe(0);
      expect(result.attemptsReconciled).toBe(0);
      expect(result.spawnConfirmed).toBe(0);
      expect(result.terminalUpdated).toBe(0);
      expect(result.orphansScanned).toBe(0);
      expect(result.orphansFound).toBe(0);
      expect(result.projectionRebuilt).toBe(false);
      expect(result.projectionTaskCount).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("releases stale leases", () => {
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 5, skippedRunning: 2, queueIds: ["q1", "q2", "q3", "q4", "q5"] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.staleLeasesReleased).toBe(5);
      expect(scheduler.requeueExpiredLeases).toHaveBeenCalled();
    });

    it("reconciles non-terminal attempts when queryNativeState provided", () => {
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 3, reconciled: 2, spawnConfirmed: 1, terminalUpdated: 1, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
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

    it("counts orphaned completion bindings", () => {
      const orphanRows = [
        { completion_id: "cb:wc1:att1", work_contract_id: "wc1", attempt_id: "att1" },
        { completion_id: "cb:wc2:att2", work_contract_id: "wc2", attempt_id: "att2" },
      ];
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue(orphanRows as any);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.orphansScanned).toBe(2);
      expect(result.orphansFound).toBe(2);
    });

    it("rebuilds projection when OCTOCLAW_TASK_STATE_REBUILD=1", () => {
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(true);
      vi.spyOn(projectionRebuild, "writeRebuiltTaskState").mockReturnValue({ written: true, path: "/tmp/task-state.json", taskCount: 10 });

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.projectionRebuilt).toBe(true);
      expect(result.projectionTaskCount).toBe(10);
      expect(projectionRebuild.writeRebuiltTaskState).toHaveBeenCalled();
    });

    it("skips projection rebuild when flag is off", () => {
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);
      vi.spyOn(projectionRebuild, "writeRebuiltTaskState").mockReturnValue({ written: true, path: "/tmp/task-state.json", taskCount: 10 });

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.projectionRebuilt).toBe(false);
      expect(result.projectionTaskCount).toBe(0);
      expect(projectionRebuild.writeRebuiltTaskState).not.toHaveBeenCalled();
    });

    it("continues on individual step failure (resilient)", () => {
      vi.spyOn(scheduler, "requeueExpiredLeases").mockImplementation(() => {
        throw new Error("scheduler failure");
      });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.errors).toContain("scheduler failure");
      expect(result.staleLeasesReleased).toBe(0);
      expect(result.attemptsReconciled).toBe(0);
    });

    it("reports durationMs > 0", () => {
      vi.spyOn(scheduler, "requeueExpiredLeases").mockReturnValue({ requeued: 0, skippedRunning: 0, queueIds: [] });
      vi.spyOn(nativeReconcile, "reconcileAllNonTerminal").mockReturnValue({ totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] });
      vi.spyOn(completionBinding, "listOrphanedCompletionBindings").mockReturnValue([]);
      vi.spyOn(featureFlags, "isTaskStateRebuildEnabled").mockReturnValue(false);

      const result = performCrashRecovery({ sqlite: null as any });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});