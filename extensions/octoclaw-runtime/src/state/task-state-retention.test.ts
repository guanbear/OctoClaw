import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneTaskStateCache, readArchivedTaskState } from "./task-state-retention.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };
const tempDirs: string[] = [];

function makePaths() {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-task-retention-"));
  tempDirs.push(dir);
  return {
    dir,
    taskStatePath: path.join(dir, "task-state.json"),
    archivePath: path.join(dir, "task-state.archive.jsonl"),
    checkpointPath: path.join(dir, "task-state-retention.json"),
  };
}

function readTaskIds(taskStatePath: string): string[] {
  const parsed = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks?: Array<{ id?: string }> };
  return (parsed.tasks ?? []).map((task) => String(task.id ?? "")).filter(Boolean);
}

describe("task state retention", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives stale active records after the one hour visibility TTL", () => {
    const paths = makePaths();
    fsSync.writeFileSync(paths.taskStatePath, JSON.stringify({
      tasks: [
        { id: "task-stale", status: "running", updated_at: "2026-04-25T00:30:00.000Z" },
        { id: "task-fresh", status: "running", updated_at: "2026-04-25T01:30:00.000Z" },
      ],
    }), "utf-8");

    const result = pruneTaskStateCache({
      ...paths,
      now: "2026-04-25T02:00:00.000Z",
      minRunIntervalMs: 0,
      force: true,
    });

    expect(result.archivedTaskIds).toEqual(["task-stale"]);
    expect(result.archived).toBe(1);
    expect(readTaskIds(paths.taskStatePath)).toEqual(["task-fresh"]);
    expect(readArchivedTaskState({ archivePath: paths.archivePath }).map((task) => task.id)).toEqual(["task-stale"]);
  });

  it("archives stale sealed WorkContract records", () => {
    const paths = makePaths();
    fsSync.writeFileSync(paths.taskStatePath, JSON.stringify({
      tasks: [
        { id: "wc-stale-reply", route: "reply", status: "sealed", updated_at: "2026-04-25T00:30:00.000Z" },
        { id: "wc-fresh-reply", route: "reply", status: "sealed", updated_at: "2026-04-25T01:30:00.000Z" },
      ],
    }), "utf-8");

    const result = pruneTaskStateCache({
      ...paths,
      now: "2026-04-25T02:00:00.000Z",
      minRunIntervalMs: 0,
      force: true,
    });

    expect(result.archivedTaskIds).toEqual(["wc-stale-reply"]);
    expect(readTaskIds(paths.taskStatePath)).toEqual(["wc-fresh-reply"]);
    expect(readArchivedTaskState({ archivePath: paths.archivePath }).map((task) => task.id)).toEqual(["wc-stale-reply"]);
  });

  it("archives terminal records after the terminal retention window", () => {
    const paths = makePaths();
    fsSync.writeFileSync(paths.taskStatePath, JSON.stringify({
      tasks: [
        { id: "task-old-done", status: "completed", completed_at: "2026-04-23T23:00:00.000Z" },
        { id: "task-recent-done", status: "completed", completed_at: "2026-04-24T12:30:00.000Z" },
      ],
    }), "utf-8");

    const result = pruneTaskStateCache({
      ...paths,
      now: "2026-04-25T01:00:00.000Z",
      minRunIntervalMs: 0,
      force: true,
    });

    expect(result.archivedTaskIds).toEqual(["task-old-done"]);
    expect(readTaskIds(paths.taskStatePath)).toEqual(["task-recent-done"]);
  });

  it("deletes archive entries after the archive deletion TTL", () => {
    const paths = makePaths();
    const oldEntry = {
      schemaVersion: "octoclaw.task_state_archive/v1",
      archivedAt: "2026-04-24T00:00:00.000Z",
      archiveReason: "stale_active_retention_expired:running",
      sourcePath: paths.taskStatePath,
      taskId: "task-archive-old",
      task: { id: "task-archive-old", status: "running", updated_at: "2026-04-23T23:00:00.000Z" },
    };
    const freshEntry = {
      ...oldEntry,
      archivedAt: "2026-04-25T00:30:00.000Z",
      taskId: "task-archive-fresh",
      task: { id: "task-archive-fresh", status: "running", updated_at: "2026-04-25T00:00:00.000Z" },
    };
    fsSync.writeFileSync(paths.taskStatePath, JSON.stringify({ tasks: [] }), "utf-8");
    fsSync.writeFileSync(paths.archivePath, `${JSON.stringify(oldEntry)}\n${JSON.stringify(freshEntry)}\n`, "utf-8");

    const result = pruneTaskStateCache({
      ...paths,
      now: "2026-04-25T01:00:00.000Z",
      archiveDeleteAfterMs: 60 * 60 * 1000,
      minRunIntervalMs: 0,
      force: true,
    });

    expect(result.deletedArchiveEntries).toBe(1);
    expect(readArchivedTaskState({ archivePath: paths.archivePath }).map((task) => task.id)).toEqual(["task-archive-fresh"]);
  });

  it("throttles repeated retention runs by checkpoint", () => {
    const paths = makePaths();
    fsSync.writeFileSync(paths.taskStatePath, JSON.stringify({ tasks: [] }), "utf-8");

    const first = pruneTaskStateCache({ ...paths, now: "2026-04-25T01:00:00.000Z", force: true });
    const second = pruneTaskStateCache({ ...paths, now: "2026-04-25T01:05:00.000Z" });

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("retention_throttled");
  });
});
