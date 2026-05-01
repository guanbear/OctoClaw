import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readTaskStateDocumentDetailed,
  upsertTaskStateRecord,
  writeTaskStateDocumentSafe,
} from "./task-state-store.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(pathname: string): string[];
  writeFileSync(pathname: string, data: string, encoding: string): void;
  readFileSync(pathname: string, encoding: string): string;
  chmodSync(pathname: string, mode: number): void;
  existsSync(pathname: string): boolean;
  renameSync(oldPath: string, newPath: string): void;
};
const osModule = os as unknown as { tmpdir(): string };
const tempDirs: string[] = [];

function makePaths() {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-task-state-errors-"));
  tempDirs.push(dir);
  return {
    dir,
    taskStatePath: path.join(dir, "task-state.json"),
  };
}

function quarantineFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.startsWith("task-state.json.corrupt."));
}

describe("task state store error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks writes when existing state returns io_error", () => {
    const paths = makePaths();
    fs.writeFileSync(paths.taskStatePath, JSON.stringify({ tasks: [{ id: "existing" }] }), "utf-8");
    fs.chmodSync(paths.dir, 0o000);

    const result = writeTaskStateDocumentSafe({ tasks: [{ id: "new" }] }, paths.taskStatePath);

    fs.chmodSync(paths.dir, 0o700);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("read_failed_closed");
    expect(JSON.parse(fs.readFileSync(paths.taskStatePath, "utf-8"))).toEqual({ tasks: [{ id: "existing" }] });
  });

  it("quarantines schema_mismatch before rebuilding state", () => {
    const paths = makePaths();
    fs.writeFileSync(paths.taskStatePath, JSON.stringify(["not", "a", "record"]), "utf-8");

    const before = readTaskStateDocumentDetailed(paths.taskStatePath);
    const result = writeTaskStateDocumentSafe({ tasks: [{ id: "rebuilt" }] }, paths.taskStatePath);

    expect(before.status).toBe("schema_mismatch");
    expect(result.ok).toBe(true);
    expect(result.quarantined).toBe(true);
    expect(quarantineFiles(paths.dir).some((entry) => !entry.endsWith(".recovery-needed"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.taskStatePath, "utf-8"))).toMatchObject({ tasks: [{ id: "rebuilt" }] });
  });

  it("preserves parse_error quarantine recovery signal when rebuild is unavailable", () => {
    const paths = makePaths();
    fs.writeFileSync(paths.taskStatePath, "{bad json", "utf-8");
    const realRenameSync = fs.renameSync.bind(fs);
    let renameCalls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath: string, newPath: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        realRenameSync(oldPath, newPath);
        return;
      }
      throw new Error("simulated rebuild unavailable");
    });

    const result = writeTaskStateDocumentSafe({ tasks: [{ id: "rebuilt" }] }, paths.taskStatePath);

    expect(result.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(quarantineFiles(paths.dir).some((entry) => entry.endsWith(".recovery-needed"))).toBe(true);
  });

  it("upsertTaskStateRecord refuses writes on io_error", () => {
    const paths = makePaths();
    fs.writeFileSync(paths.taskStatePath, JSON.stringify({ tasks: [{ id: "existing" }] }), "utf-8");
    fs.chmodSync(paths.dir, 0o000);

    const wrote = upsertTaskStateRecord({ id: "new" }, paths.taskStatePath);

    fs.chmodSync(paths.dir, 0o700);
    expect(wrote).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.taskStatePath, "utf-8"))).toEqual({ tasks: [{ id: "existing" }] });
  });
});
