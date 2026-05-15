import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRouterWizardState } from "../flow.js";
import {
  loadRouterWizardState,
  routerWizardStatePath,
  saveRouterWizardState,
} from "../state-store.js";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-slack-wizard-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Slack router wizard state store", () => {
  it("writes state atomically to the router wizard state path", async () => {
    const state = createRouterWizardState({
      models: ["openai/gpt-5.5"],
      now: "2026-05-15T00:00:00.000Z",
    });

    const filePath = await saveRouterWizardState(state, { openclawHome: tmpDir });

    expect(filePath).toBe(routerWizardStatePath(tmpDir));
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toThrow();
    const loaded = await loadRouterWizardState({ openclawHome: tmpDir });
    expect(loaded.state?.schemaVersion).toBe("octoclaw.router_wizard_state/v1");
    expect(loaded.state?.remainingModels).toEqual(["openai/gpt-5.5"]);
  });

  it("recovers from a corrupt state file without throwing", async () => {
    const filePath = routerWizardStatePath(tmpDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not-json", "utf8");

    const loaded = await loadRouterWizardState({ openclawHome: tmpDir });

    expect(loaded.state).toBeNull();
    expect(loaded.recovered).toBe(true);
    const files = await fs.readdir(path.dirname(filePath));
    expect(files.some((name) => name.startsWith("router-wizard.state.json.corrupt-"))).toBe(true);
  });
});
