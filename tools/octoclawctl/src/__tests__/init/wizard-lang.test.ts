import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnSync } from "node:child_process";
import { runInitWizard } from "../../commands/init.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

describe("init wizard language", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("CLI-I-010 returns English-only output when lang is en", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `init-lang-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      mockedSpawnSync.mockImplementation((command: string) => {
        if (command === "openclaw") {
          return { status: 0, stdout: "OpenClaw 2026.5.12 (test)\n", stderr: "", signal: null, output: [], pid: 123 };
        }
        return { status: 0, stdout: "", stderr: "", signal: null, output: [], pid: 124 };
      });

      const output = await runInitWizard({
        nonInteractive: true,
        lang: "en",
        openclawHome: tmpDir,
      });

      expect(output).not.toMatch(/[\u3400-\u9fff]/u);
      expect(output).toContain("Initialization complete");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
