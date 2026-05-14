import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openSqliteCostEventStore } from "@octoclaw/router";

import {
  buildRuntimeCostEvent,
  recordRuntimeCostEventAndBudget,
} from "./router-cost-runtime.js";

describe("router runtime cost recording", () => {
  it("builds a cost event from runtime usage fields", () => {
    const event = buildRuntimeCostEvent({
      event: {
        model: "openai/gpt-5.5",
        usage: { input_tokens: 1200, output_tokens: 800, cost_usd: 0.42 },
        latencyMs: 1234,
        outcome: "success",
      },
      ctx: { sessionKey: "agent:main:slack:default:direct:u123" },
      state: { decision: { route: "delegate", complexity: "normal" } },
      stateKey: "agent:main:slack:default:direct:u123",
      now: new Date("2026-05-14T00:00:00.000Z"),
    });

    expect(event).toMatchObject({
      ts: "2026-05-14T00:00:00.000Z",
      sessionKey: "agent:main:slack:default:direct:u123",
      model: "openai/gpt-5.5",
      complexity: "normal",
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.42,
      route: "delegate",
      outcome: "success",
      latencyMs: 1234,
    });
  });

  it("records cost into cost.sqlite and logs budget warnings after task end", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-runtime-cost-"));
    const octoclawDir = path.join(tempHome, "octoclaw");
    fs.mkdirSync(octoclawDir, { recursive: true });
    fs.writeFileSync(path.join(octoclawDir, "router-wizard.json"), JSON.stringify({
      schemaVersion: "octoclaw.router_wizard/v1",
      completedAt: "2026-05-14T00:00:00.000Z",
      models: { "openai/gpt-5.5": { planType: "pay_as_you_go", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" } },
      budget: { monthly: 100, currency: "USD" },
      privacy: "standard",
      language: "auto",
      restrictedModels: [],
      overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
    }), "utf8");
    const logger = { warn: vi.fn() };
    try {
      const result = recordRuntimeCostEventAndBudget({
        openclawHome: tempHome,
        event: {
          model: "openai/gpt-5.5",
          usage: { inputTokens: 10, outputTokens: 20, costUsd: 84 },
        },
        ctx: { sessionKey: "agent:main:slack:default:direct:u123" },
        state: { decision: { route: "delegate", complexity: "deep" } },
        stateKey: "agent:main:slack:default:direct:u123",
        now: new Date("2026-05-14T00:00:00.000Z"),
        logger,
      });

      expect(result).toMatchObject({ recorded: true, budget: { action: "warn" } });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Budget 84% used"));
      const opened = openSqliteCostEventStore({ dbPath: path.join(octoclawDir, "cost.sqlite") });
      expect(opened.store?.list()).toEqual([
        expect.objectContaining({ model: "openai/gpt-5.5", costUsd: 84, complexity: "deep" }),
      ]);
      opened.store?.close();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
