import fsSync from "node:fs";
import path from "node:path";

import {
  resolveTaskStateArchivePath,
  resolveTaskStatePath,
  resolveTaskStateRetentionPath,
} from "../resolve/env.js";
import { asRecord, asString } from "../util/type-coercion.js";
import type { TaskStateRecord } from "./task-state-store.js";

const TASK_STATE_ARCHIVE_SCHEMA_VERSION = "octoclaw.task_state_archive/v1";

export const DEFAULT_TASK_STATE_STALE_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_TASK_STATE_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_TASK_STATE_ARCHIVE_DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface TaskStateArchiveEntry {
  schemaVersion: typeof TASK_STATE_ARCHIVE_SCHEMA_VERSION;
  archivedAt: string;
  archiveReason: string;
  sourcePath: string;
  taskId: string;
  task: TaskStateRecord;
}

export interface TaskStateRetentionOptions {
  taskStatePath?: string;
  archivePath?: string;
  checkpointPath?: string;
  now?: string | Date;
  staleRetentionMs?: number;
  terminalRetentionMs?: number;
  minRunIntervalMs?: number;
  force?: boolean;
  maxArchivePerRun?: number;
  archiveDeleteAfterMs?: number;
}

export interface TaskStateRetentionResult {
  scanned: number;
  kept: number;
  archived: number;
  skipped: boolean;
  reason?: string;
  archivePath: string;
  taskStatePath: string;
  checkpointPath: string;
  archivedTaskIds: string[];
  deletedArchiveEntries?: number;
}

function timestampMs(value: unknown): number | null {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestampMs(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = timestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function ensureParentDir(filePath: string): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(fsSync.readFileSync(filePath, "utf-8")));
  } catch {
    return {};
  }
}

function normalizeStatus(status: unknown): string {
  const raw = asString(status, "unknown").toLowerCase();
  if (raw === "done" || raw === "succeeded") return "completed";
  if (raw === "cancelled") return "canceled";
  return raw;
}

function archiveReasonForTask(task: TaskStateRecord, nowMs: number, staleRetentionMs: number, terminalRetentionMs: number): string | null {
  const status = normalizeStatus(task.status);
  const terminalStatuses = new Set(["failed", "completed", "canceled"]);
  // "registered" = sealed WorkContract but dispatch never executed.
  // "deliverable_ready" = result exists but delivery pending.
  // Both should age out under the stale window like other active statuses.
  const activeOrStaleStatuses = new Set(["running", "queued", "planned", "materializing", "blocked", "timed_out", "registered", "deliverable_ready", "sealed"]);

  if (terminalStatuses.has(status)) {
    const relevantMs = firstTimestampMs(task.completed_at, task.failed_at, task.updated_at, task.started_at, task.spawned_at, task.created_at);
    if (relevantMs !== null && nowMs - relevantMs >= terminalRetentionMs) return `terminal_retention_expired:${status}`;
    return null;
  }

  if (activeOrStaleStatuses.has(status)) {
    const relevantMs = firstTimestampMs(task.updated_at, task.started_at, task.spawned_at, task.created_at);
    if (relevantMs !== null && nowMs - relevantMs >= staleRetentionMs) return `stale_active_retention_expired:${status}`;
  }

  return null;
}

function shouldSkipForThrottle(checkpointPath: string, nowMs: number, minRunIntervalMs: number, force: boolean): boolean {
  if (force || minRunIntervalMs <= 0) return false;
  const checkpoint = readJsonFile(checkpointPath);
  const lastRunMs = timestampMs(checkpoint.lastRunAt);
  return lastRunMs !== null && nowMs - lastRunMs < minRunIntervalMs;
}

function writeCheckpoint(checkpointPath: string, result: Omit<TaskStateRetentionResult, "checkpointPath" | "archivePath" | "taskStatePath">, nowIso: string): void {
  ensureParentDir(checkpointPath);
  fsSync.writeFileSync(checkpointPath, JSON.stringify({
    schemaVersion: "octoclaw.task_state_retention/v1",
    lastRunAt: nowIso,
    ...result,
  }, null, 2), "utf-8");
}


function entryRelevantMs(entry: TaskStateArchiveEntry): number | null {
  return timestampMs(entry.archivedAt)
    ?? firstTimestampMs(entry.task.completed_at, entry.task.failed_at, entry.task.updated_at, entry.task.started_at, entry.task.spawned_at, entry.task.created_at);
}

function pruneArchiveFile(archivePath: string, nowMs: number, archiveDeleteAfterMs: number): number {
  if (archiveDeleteAfterMs <= 0) return 0;
  let lines: string[] = [];
  try {
    lines = fsSync.readFileSync(archivePath, "utf-8").split(/\r?\n/u).filter(Boolean);
  } catch {
    return 0;
  }
  const kept: string[] = [];
  let deleted = 0;
  for (const line of lines) {
    try {
      const entry = asRecord(JSON.parse(line)) as unknown as TaskStateArchiveEntry;
      const relevantMs = entryRelevantMs(entry);
      if (relevantMs !== null && nowMs - relevantMs >= archiveDeleteAfterMs) {
        deleted += 1;
        continue;
      }
    } catch {
      // Keep malformed lines rather than deleting possible evidence.
    }
    kept.push(line);
  }
  if (deleted > 0) {
    ensureParentDir(archivePath);
    fsSync.writeFileSync(archivePath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
  }
  return deleted;
}

export function pruneTaskStateCache(options: TaskStateRetentionOptions = {}): TaskStateRetentionResult {
  const taskStatePath = options.taskStatePath || resolveTaskStatePath();
  const archivePath = options.archivePath || resolveTaskStateArchivePath();
  const checkpointPath = options.checkpointPath || resolveTaskStateRetentionPath();
  const nowMs = options.now instanceof Date ? options.now.getTime() : timestampMs(options.now) ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleRetentionMs = options.staleRetentionMs ?? DEFAULT_TASK_STATE_STALE_RETENTION_MS;
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TASK_STATE_TERMINAL_RETENTION_MS;
  const minRunIntervalMs = options.minRunIntervalMs ?? DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS;
  const maxArchivePerRun = Math.max(1, options.maxArchivePerRun ?? 500);
  const archiveDeleteAfterMs = options.archiveDeleteAfterMs ?? DEFAULT_TASK_STATE_ARCHIVE_DELETE_AFTER_MS;

  if (shouldSkipForThrottle(checkpointPath, nowMs, minRunIntervalMs, Boolean(options.force))) {
    return {
      scanned: 0,
      kept: 0,
      archived: 0,
      skipped: true,
      reason: "retention_throttled",
      archivePath,
      taskStatePath,
      checkpointPath,
      archivedTaskIds: [],
      deletedArchiveEntries: 0,
    };
  }

  const parsed = readJsonFile(taskStatePath);
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter((task): task is TaskStateRecord => Boolean(task) && typeof task === "object" && !Array.isArray(task)) : [];
  if (tasks.length === 0) {
    const deletedArchiveEntries = pruneArchiveFile(archivePath, nowMs, archiveDeleteAfterMs);
    const result = { scanned: 0, kept: 0, archived: 0, skipped: false, archivedTaskIds: [] as string[], deletedArchiveEntries };
    writeCheckpoint(checkpointPath, result, nowIso);
    return { ...result, archivePath, taskStatePath, checkpointPath };
  }

  const kept: TaskStateRecord[] = [];
  const archiveEntries: TaskStateArchiveEntry[] = [];
  for (const task of tasks) {
    const reason = archiveEntries.length < maxArchivePerRun
      ? archiveReasonForTask(task, nowMs, staleRetentionMs, terminalRetentionMs)
      : null;
    if (!reason) {
      kept.push(task);
      continue;
    }
    archiveEntries.push({
      schemaVersion: TASK_STATE_ARCHIVE_SCHEMA_VERSION,
      archivedAt: nowIso,
      archiveReason: reason,
      sourcePath: taskStatePath,
      taskId: asString(task.id),
      task,
    });
  }

  if (archiveEntries.length > 0) {
    ensureParentDir(archivePath);
    let existingArchive = "";
    try {
      existingArchive = fsSync.readFileSync(archivePath, "utf-8");
    } catch {
      existingArchive = "";
    }
    fsSync.writeFileSync(archivePath, `${existingArchive}${archiveEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
    ensureParentDir(taskStatePath);
    fsSync.writeFileSync(taskStatePath, JSON.stringify({
      ...parsed,
      tasks: kept,
      retention: {
        schemaVersion: "octoclaw.task_state_retention_marker/v1",
        lastPrunedAt: nowIso,
        archivedCount: archiveEntries.length,
        archivePath,
      },
    }, null, 2), "utf-8");
  }

  const deletedArchiveEntries = pruneArchiveFile(archivePath, nowMs, archiveDeleteAfterMs);
  const result = {
    scanned: tasks.length,
    kept: kept.length,
    archived: archiveEntries.length,
    skipped: false,
    archivedTaskIds: archiveEntries.map((entry) => entry.taskId).filter(Boolean),
    deletedArchiveEntries,
  };
  writeCheckpoint(checkpointPath, result, nowIso);
  return { ...result, archivePath, taskStatePath, checkpointPath };
}

export function readArchivedTaskState(options: { archivePath?: string; limit?: number } = {}): TaskStateRecord[] {
  const archivePath = options.archivePath || resolveTaskStateArchivePath();
  const limit = Math.max(1, options.limit ?? 500);
  try {
    const lines = fsSync.readFileSync(archivePath, "utf-8").split(/\r?\n/u).filter(Boolean);
    return lines.slice(-limit).reverse().map((line) => {
      try {
        const parsed = asRecord(JSON.parse(line));
        return asRecord(parsed.task) as TaskStateRecord;
      } catch {
        return {} as TaskStateRecord;
      }
    }).filter((task) => Object.keys(task).length > 0);
  } catch {
    return [];
  }
}
