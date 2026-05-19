import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { input, select } from "@inquirer/prompts";
import { runStepJudgeModel } from "../../commands/init/steps/step-judge-model.js";
import type { WizardState } from "../../commands/init/wizard-state.js";

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  select: vi.fn(),
}));

const mockedInput = vi.mocked(input);
const mockedSelect = vi.mocked(select);

function emptyState(): WizardState {
  return {
    openclawVersion: null,
    judgeModel: null,
    imChannels: [],
    imTokens: {},
    doctorResults: [],
  };
}

async function makeHome(name: string): Promise<{ tmpDir: string; openclawHome: string }> {
  const tmpDir = path.join(
    os.homedir(),
    ".octoclawctl-test-tmp",
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const openclawHome = path.join(tmpDir, ".openclaw");
  await fs.mkdir(openclawHome, { recursive: true });
  return { tmpDir, openclawHome };
}

describe("Judge model init step", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("MOF-002 stores gpt-5.4-mini as remote Judge from discovered cliproxy provider", async () => {
    mockedSelect.mockResolvedValue("remote-gpt-5-4-mini");
    const { tmpDir, openclawHome } = await makeHome("judge-step-cliproxy");
    try {
      await fs.writeFile(
        path.join(openclawHome, "openclaw.json"),
        JSON.stringify({
          models: {
            providers: {
              cliproxyapi: {
                baseUrl: "https://cliproxyapi.example.com/v1",
                apiKey: "sk-cliproxy",
                models: [{ id: "gpt-5.4-mini" }],
              },
            },
          },
        }),
        "utf8",
      );

      const state = emptyState();
      await runStepJudgeModel(state, { nonInteractive: false, lang: "zh", openclawHome });

      expect(state.judgeModel).toEqual({
        type: "remote-gpt-5-4-mini",
        modelId: "gpt-5.4-mini",
        baseUrl: "https://cliproxyapi.example.com/v1",
        apiKey: "sk-cliproxy",
      });
      expect(state.judgeModel?.type.startsWith("ollama")).toBe(false);
      expect(mockedInput).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prompts for base URL and API key when no compatible provider is discovered", async () => {
    mockedSelect.mockResolvedValue("remote-gpt-5-4-mini");
    mockedInput
      .mockResolvedValueOnce("https://custom.example.com/v1")
      .mockResolvedValueOnce("sk-custom");
    const { tmpDir, openclawHome } = await makeHome("judge-step-prompt");
    try {
      const state = emptyState();
      await runStepJudgeModel(state, { nonInteractive: false, lang: "en", openclawHome });

      expect(state.judgeModel).toEqual({
        type: "remote-gpt-5-4-mini",
        modelId: "gpt-5.4-mini",
        baseUrl: "https://custom.example.com/v1",
        apiKey: "sk-custom",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
