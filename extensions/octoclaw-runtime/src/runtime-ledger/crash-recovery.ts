import { requeueExpiredLeases } from "./scheduler.js";
import { reconcileAllNonTerminal, type NativeLifecycleState } from "./native-reconcile.js";
import { listOrphanedCompletionBindings } from "./completion-binding.js";
import { writeRebuiltTaskState } from "./projection-rebuild.js";
import { isTaskStateRebuildEnabled } from "./feature-flags.js";
import type { SqliteProvider } from "./types.js";

export interface CrashRecoveryInput {
  dbPath?: string;
  sqlite?: SqliteProvider;
  completionsDir?: string;
  queryNativeState?: (attempt: { nativeFlowId: string | null; nativeTaskId: string | null }) => NativeLifecycleState | null;
  now?: Date;
}

export interface CrashRecoveryResult {
  staleLeasesReleased: number;
  attemptsReconciled: number;
  spawnConfirmed: number;
  terminalUpdated: number;
  orphansScanned: number;
  orphansFound: number;
  projectionRebuilt: boolean;
  projectionTaskCount: number;
  errors: string[];
  durationMs: number;
}

export function performCrashRecovery(input: CrashRecoveryInput = {}): CrashRecoveryResult {
  const startTime = Date.now();
  const errors: string[] = [];

  let staleLeasesReleased = 0;
  let attemptsReconciled = 0;
  let spawnConfirmed = 0;
  let terminalUpdated = 0;
  let orphansScanned = 0;
  let orphansFound = 0;
  let projectionRebuilt = false;
  let projectionTaskCount = 0;

  try {
    const requeueResult = requeueExpiredLeases({ dbPath: input.dbPath, sqlite: input.sqlite, now: input.now });
    staleLeasesReleased = requeueResult.requeued;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const reconcileResult = reconcileAllNonTerminal({
      dbPath: input.dbPath,
      sqlite: input.sqlite,
      queryNativeState: input.queryNativeState,
    });
    attemptsReconciled = reconcileResult.reconciled;
    spawnConfirmed = reconcileResult.spawnConfirmed;
    terminalUpdated = reconcileResult.terminalUpdated;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const orphans = listOrphanedCompletionBindings({ dbPath: input.dbPath, sqlite: input.sqlite });
    orphansScanned = orphans.length;
    orphansFound = orphans.length;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (isTaskStateRebuildEnabled()) {
    try {
      const writeResult = writeRebuiltTaskState({ dbPath: input.dbPath, sqlite: input.sqlite });
      projectionRebuilt = writeResult.written;
      projectionTaskCount = writeResult.taskCount;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    staleLeasesReleased,
    attemptsReconciled,
    spawnConfirmed,
    terminalUpdated,
    orphansScanned,
    orphansFound,
    projectionRebuilt,
    projectionTaskCount,
    errors,
    durationMs: Date.now() - startTime,
  };
}