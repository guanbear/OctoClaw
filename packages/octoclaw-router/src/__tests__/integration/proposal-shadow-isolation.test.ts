import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildPromotionState, getPromotionState } from "../../promotion/index.js";
import { acceptProposal, createWizardConfig, recordProbeSuccess } from "../../wizard/index.js";

function makeHome(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "octoclaw-router-proposal-"));
}

describe("proposal/shadow isolation", () => {
  it("does not let unconfigured proposal states become live", () => {
    const state = buildPromotionState([
      {
        ts: "2026-05-15T00:00:00.000Z",
        model: "openai/gpt-5-mini",
        tier: "simple",
        decision: "promote",
        reason: "meets_promotion_criteria",
      },
    ], []);

    expect(getPromotionState(state, "openai/gpt-5-mini", "simple")).toMatchObject({
      state: "shadow",
      reason: "not_configured",
    });
  });

  it("acceptProposal appends a model under a configured provider and writes a backup", async () => {
    const openclawHome = makeHome();
    try {
      fsSync.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.example.test/v1",
              authHeader: { name: "authorization", value: "secret-token" },
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      }, null, 2));
      const wizard = createWizardConfig(["openai/gpt-5.5"], { now: "2026-05-15T00:00:00.000Z" });
      wizard.models["openai/gpt-5-mini"] = {
        planType: "pay_as_you_go",
        configuredAt: "2026-05-15T00:00:00.000Z",
        source: "same_provider_discovery",
        state: "proposal_candidate",
        stateUpdatedAt: "2026-05-15T00:00:00.000Z",
        lastProbeOkAt: "2026-05-14T00:00:00.000Z",
      };
      fsSync.mkdirSync(path.join(openclawHome, "octoclaw"), { recursive: true });
      fsSync.writeFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), `${JSON.stringify(wizard, null, 2)}\n`);
      const renameSpy = vi.spyOn(fsSync, "renameSync");

      const result = await acceptProposal("openai/gpt-5-mini", openclawHome, {
        now: "2026-05-15T00:00:00.000Z",
      });

      expect(result).toMatchObject({ ok: true, modelKey: "openai/gpt-5-mini" });
      const openclaw = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "openclaw.json"), "utf8")) as {
        models: { providers: { openai: { models: Array<{ id: string }> } } };
      };
      expect(openclaw.models.providers.openai.models).toEqual([{ id: "gpt-5.5" }, { id: "gpt-5-mini", name: "gpt-5-mini" }]);
      const backupPath = path.join(openclawHome, "openclaw.json.octoclaw-bak-2026-05-15T00-00-00.000Z");
      expect(fsSync.existsSync(backupPath)).toBe(true);
      expect(result.backupPath.slice(openclawHome.length)).not.toContain(":");
      expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(".tmp."), path.join(openclawHome, "openclaw.json"));
      expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(".tmp."), path.join(openclawHome, "octoclaw", "router-wizard.json"));
      const backup = JSON.parse(fsSync.readFileSync(backupPath, "utf8")) as {
        models: { providers: { openai: { models: Array<{ id: string }> } } };
      };
      expect(backup.models.providers.openai.models).toEqual([{ id: "gpt-5.5" }]);
      const updatedWizard = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8"));
      expect(updatedWizard.models["openai/gpt-5-mini"].state).toBe("shadow_candidate");
      renameSpy.mockRestore();
    } finally {
      fsSync.rmSync(openclawHome, { recursive: true, force: true });
    }
  });

  it("acceptProposal refuses stale probes and missing provider blocks", async () => {
    const openclawHome = makeHome();
    try {
      fsSync.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.example.test/v1",
              authHeader: { name: "authorization", value: "secret-token" },
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      }));
      const wizard = createWizardConfig([], { now: "2026-05-15T00:00:00.000Z" });
      wizard.models["openai/gpt-5-mini"] = {
        planType: "pay_as_you_go",
        configuredAt: "2026-05-15T00:00:00.000Z",
        source: "same_provider_discovery",
        state: "proposal_candidate",
        stateUpdatedAt: "2026-05-15T00:00:00.000Z",
        lastProbeOkAt: "2026-05-01T00:00:00.000Z",
      };
      fsSync.mkdirSync(path.join(openclawHome, "octoclaw"), { recursive: true });
      fsSync.writeFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), `${JSON.stringify(wizard, null, 2)}\n`);

      await expect(acceptProposal("openai/gpt-5-mini", openclawHome, {
        now: "2026-05-15T00:00:00.000Z",
      })).rejects.toThrow("No successful probe");

      wizard.models["openai/gpt-5-mini"]!.lastProbeOkAt = "2026-05-14T00:00:00.000Z";
      fsSync.writeFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), `${JSON.stringify(wizard, null, 2)}\n`);
      await expect(acceptProposal("nonexistent/model", openclawHome, {
        now: "2026-05-15T00:00:00.000Z",
      })).rejects.toThrow("这个模型属于 `nonexistent`");
    } finally {
      fsSync.rmSync(openclawHome, { recursive: true, force: true });
    }
  });

  it("records successful proposal probes without configuring the model", async () => {
    const openclawHome = makeHome();
    try {
      const wizard = createWizardConfig(["cliproxyapi/gpt-5.5"], { now: "2026-05-15T00:00:00.000Z" });
      wizard.models["cliproxyapi/gpt-5-mini"] = {
        planType: "pay_as_you_go",
        configuredAt: "2026-05-15T00:00:00.000Z",
        source: "same_provider_discovery",
        state: "proposal_candidate",
        stateUpdatedAt: "2026-05-15T00:00:00.000Z",
      };
      fsSync.mkdirSync(path.join(openclawHome, "octoclaw"), { recursive: true });
      fsSync.writeFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), `${JSON.stringify(wizard, null, 2)}\n`);

      const result = await recordProbeSuccess("cliproxyapi/gpt-5-mini", openclawHome, {
        now: "2026-05-16T00:00:00.000Z",
      });

      expect(result).toMatchObject({ ok: true, modelKey: "cliproxyapi/gpt-5-mini" });
      const updatedWizard = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8"));
      expect(updatedWizard.models["cliproxyapi/gpt-5-mini"]).toMatchObject({
        source: "same_provider_discovery",
        state: "probed_ok",
        lastProbeOkAt: "2026-05-16T00:00:00.000Z",
      });
      expect(updatedWizard.models["cliproxyapi/gpt-5-mini"].source).not.toBe("configured");
    } finally {
      fsSync.rmSync(openclawHome, { recursive: true, force: true });
    }
  });
});
