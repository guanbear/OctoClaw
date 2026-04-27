import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteJsonSync } from "./atomic-write.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readFileSync(p: string, enc: string): string;
  writeFileSync(p: string, data: string, enc: string): void;
  readdirSync(p: string): string[];
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;

describe("atomicWriteJsonSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-atomic-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON that can be parsed back", () => {
    const target = path.join(tmpDir, "test.json");
    const data = { hello: "world", count: 42 };

    const result = atomicWriteJsonSync(target, data);

    expect(result).toBe(true);
    const raw = fs.readFileSync(target, "utf-8");
    expect(JSON.parse(raw)).toEqual(data);
  });

  it("uses temp file then renames (no leftover temp files)", () => {
    const target = path.join(tmpDir, "rename-test.json");
    const data = { step: "two" };

    atomicWriteJsonSync(target, data);

    const raw = fs.readFileSync(target, "utf-8");
    expect(JSON.parse(raw)).toEqual(data);

    const leftoverTemps = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp."));
    expect(leftoverTemps).toEqual([]);
  });

  it("replaces existing file atomically", () => {
    const target = path.join(tmpDir, "replace-test.json");

    atomicWriteJsonSync(target, { version: 1 });
    atomicWriteJsonSync(target, { version: 2 });

    const raw = fs.readFileSync(target, "utf-8");
    expect(JSON.parse(raw)).toEqual({ version: 2 });
  });

  it("returns false on write failure", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not-a-dir", "utf-8");
    const target = path.join(blocker, "sub", "fail.json");

    const result = atomicWriteJsonSync(target, { fail: true });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("octoclaw atomic write failed"));
    warnSpy.mockRestore();
  });

  it("creates parent directory if needed", () => {
    const target = path.join(tmpDir, "new", "nested", "dir", "test.json");
    const data = { nested: true };

    const result = atomicWriteJsonSync(target, data);

    expect(result).toBe(true);
    const raw = fs.readFileSync(target, "utf-8");
    expect(JSON.parse(raw)).toEqual(data);
  });
});
