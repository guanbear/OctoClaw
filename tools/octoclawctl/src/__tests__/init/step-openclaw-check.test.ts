import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnSync } from "node:child_process";
import { runStepOpenClawCheck } from "../../commands/init/steps/step-openclaw-check.js";
import type { WizardState } from "../../commands/init/wizard-state.js";
import type { WizardOpts } from "../../commands/init/wizard-opts.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

function createState(): WizardState {
  return {
    openclawVersion: null,
    judgeModel: null,
    imChannels: [],
    imTokens: {},
    doctorResults: [],
  };
}

function createOpts(): WizardOpts {
  return {
    nonInteractive: true,
    lang: "en",
    openclawHome: "/tmp/openclaw",
  };
}

describe("runStepOpenClawCheck", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("CLI-I-001 throws OPENCLAW_NOT_FOUND when openclaw cannot be executed", async () => {
    mockedSpawnSync.mockReturnValue({
      error: new Error("not found"),
      status: null,
      stdout: "",
      stderr: "",
      signal: null,
      output: [],
      pid: 0,
    });

    await expect(runStepOpenClawCheck(createState(), createOpts())).rejects.toMatchObject({
      code: "OPENCLAW_NOT_FOUND",
      exitCode: 1,
    });
  });

  it("CLI-I-002 extracts and stores the OpenClaw version", async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "OpenClaw 2026.5.12 (test)\n",
      stderr: "",
      signal: null,
      output: [],
      pid: 123,
    });
    const state = createState();

    await expect(runStepOpenClawCheck(state, createOpts())).resolves.toEqual({
      version: "OpenClaw 2026.5.12 (test)",
    });
    expect(state.openclawVersion).toBe("OpenClaw 2026.5.12 (test)");
    expect(mockedSpawnSync).toHaveBeenCalledWith("openclaw", ["--version"], {
      timeout: 3000,
      encoding: "utf8",
    });
  });

  it("throws OPENCLAW_UNSUPPORTED_VERSION below 2026.5.12", async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "openclaw v2026.5.11\n",
      stderr: "",
      signal: null,
      output: [],
      pid: 123,
    });

    await expect(runStepOpenClawCheck(createState(), createOpts())).rejects.toMatchObject({
      code: "OPENCLAW_UNSUPPORTED_VERSION",
      exitCode: 1,
    });
  });
});
