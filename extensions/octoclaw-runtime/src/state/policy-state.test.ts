import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POLICY_STATE_TTL_MS, PolicyStateStore } from "./policy-state.js";

const fs = fsSync as unknown as {
  existsSync(pathname: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
};
const osModule = os as unknown as { tmpdir(): string };

describe("policyState 4.4 cache boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a five minute TTL", () => {
    expect(POLICY_STATE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("does not persist or restore cross-process state", () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-policy-state-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "runtime-policy-state.json");

    const store = new PolicyStateStore({ sessionStateFile: statePath });
    store.set("session-1", { prompt: "delegate this", delegated: true });
    store.persist();

    expect(fs.existsSync(statePath)).toBe(false);

    fs.writeFileSync(statePath, JSON.stringify({ sessions: { "session-1": { prompt: "stale", delegated: true, updatedAt: Date.now() } } }), "utf-8");
    const restarted = new PolicyStateStore({ sessionStateFile: statePath });

    expect(restarted.get("session-1")).toBeUndefined();
  });
});
