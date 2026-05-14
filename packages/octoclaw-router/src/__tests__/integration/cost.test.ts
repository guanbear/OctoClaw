import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ModelIntelLite } from "../../decision/contracts.js";
import {
  applyBudgetPlanOnly,
  estimateCostUsd,
  evaluateBudget,
  generateCostReport,
  InMemoryCostEventStore,
  openSqliteCostEventStore,
  parseCostEventsJsonl,
  renderCostReport,
  type CostEvent,
  type SqliteProvider,
} from "../../cost/index.js";

const nodeRequire = createRequire(import.meta.url);

function requireNodeSqlite(): NonNullable<SqliteProvider> {
  return nodeRequire("node:sqlite") as NonNullable<SqliteProvider>;
}

function costEvent(index: number, overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: new Date(Date.UTC(2026, 4, 13 + index, 0, 0, 0)).toISOString(),
    model: "openai/gpt-5.5",
    provider: "openai",
    complexity: "deep",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    costUsd: 5,
    route: "delegate",
    outcome: "success",
    isPlanCall: false,
    ...overrides,
  };
}

function planModel(modelKey: string, effectiveCostBand: ModelIntelLite["plan"]["effectiveCostBand"]): Pick<ModelIntelLite, "modelKey" | "plan"> {
  return {
    modelKey,
    plan: { type: "subscription", quotaPressure: "low", effectiveCostBand, sources: ["test"] },
  };
}

describe("cost reporting RT-$-001..007", () => {
  it("RT-$-001 records cost event per API call", () => {
    const store = new InMemoryCostEventStore();
    const event = costEvent(0, {
      costUsd: estimateCostUsd(1_000_000, 1_000_000, 2, 10),
    });

    store.record(event);

    expect(store.list()[0]).toMatchObject({
      model: "openai/gpt-5.5",
      complexity: "deep",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 12,
      outcome: "success",
      isPlanCall: false,
    });
  });

  it("RT-$-002 groups cost report by model", () => {
    const events = [
      ...Array.from({ length: 50 }, () => costEvent(0, { model: "openai/gpt-5.5", costUsd: 1 })),
      ...Array.from({ length: 30 }, () => costEvent(0, { model: "zhipu/glm-5.1", costUsd: 1 })),
      ...Array.from({ length: 20 }, () => costEvent(0, { model: "openai/gpt-5-mini", costUsd: 1 })),
    ];

    const report = generateCostReport(events, { period: "30d", now: new Date("2026-05-20T00:00:00.000Z").getTime() });

    expect(report.byModel["openai/gpt-5.5"]?.totalUsd).toBe(50);
    expect(report.totalUsd).toBe(100);
  });

  it("RT-$-003 groups cost report by complexity and route", () => {
    const events = [
      costEvent(0, { complexity: "simple", route: "reply", costUsd: 1 }),
      costEvent(1, { complexity: "normal", route: "delegate", costUsd: 2 }),
      costEvent(2, { complexity: "complex", route: "delegate", costUsd: 3 }),
      costEvent(3, { complexity: "deep", route: "delegate", costUsd: 4 }),
    ];

    const report = generateCostReport(events, { period: "7d", now: new Date("2026-05-17T00:00:00.000Z").getTime() });

    expect(report.byComplexity.deep?.totalUsd).toBe(4);
    expect(report.byRoute.delegate?.totalUsd).toBe(9);
    expect(renderCostReport(report)).toContain("By complexity:");
  });

  it("RT-$-004 predicts month-end from 7-day daily average", () => {
    const events = Array.from({ length: 7 }, (_, index) => costEvent(index, { costUsd: 5 }));
    const report = generateCostReport(events, { period: "7d", now: new Date("2026-05-20T00:00:00.000Z").getTime() });

    expect(report.monthEndPredictionUsd).toBe(150);
  });

  it("RT-$-005 emits budget warning at 80 percent", () => {
    expect(evaluateBudget(100, 84)).toMatchObject({
      action: "warn",
      notification: "Budget 84% used ($84/$100)",
    });
  });

  it("RT-$-006 forces plan-only model set when budget is exceeded", () => {
    const result = applyBudgetPlanOnly([
      planModel("openai/gpt-5.5", "unknown"),
      planModel("zhipu/glm-5.1", "free_or_sunk"),
    ], 100, 102);

    expect(result.models.map((model) => model.modelKey)).toEqual(["zhipu/glm-5.1"]);
    expect(result.budget.reasonCodes).toContain("budget_exceeded_plan_only");
    expect(applyBudgetPlanOnly([planModel("openai/gpt-5.5", "unknown")], 100, 102).budget.ignoredReason).toBe("budget_exceeded_no_plan");
  });

  it("RT-$-007 corrupted cost storage fails open to empty report", () => {
    const warn = vi.fn();
    const events = parseCostEventsJsonl("{not-json", { warn });
    const report = generateCostReport(events);

    expect(events).toEqual([]);
    expect(report.totalUsd).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[router-cost] cost store load failed:"));
  });

  it("persists cost events to local cost.sqlite and reads them back", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-cost-sqlite-"));
    const dbPath = path.join(tempDir, "cost.sqlite");
    const sqlite = requireNodeSqlite();
    try {
      const opened = openSqliteCostEventStore({ dbPath, sqlite });
      expect(opened.status).toBe("ok");
      opened.store?.record(costEvent(0, {
        sessionKey: "agent:main:slack:default:direct:u123",
        turnId: "turn-1",
        model: "openai/gpt-5.5",
        provider: "openai",
        complexity: "normal",
        inputTokens: 1200,
        outputTokens: 800,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        costUsd: 0.42,
        route: "delegate",
        outcome: "success",
        isPlanCall: true,
        latencyMs: 1234,
      }));
      opened.store?.close();

      const reopened = openSqliteCostEventStore({ dbPath, sqlite });
      expect(reopened.status).toBe("ok");
      expect(reopened.store?.list()).toEqual([
        expect.objectContaining({
          sessionKey: "agent:main:slack:default:direct:u123",
          turnId: "turn-1",
          model: "openai/gpt-5.5",
          provider: "openai",
          complexity: "normal",
          inputTokens: 1200,
          outputTokens: 800,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          costUsd: 0.42,
          route: "delegate",
          outcome: "success",
          isPlanCall: true,
          latencyMs: 1234,
        }),
      ]);
      reopened.store?.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("renames corrupted cost.sqlite and starts with an empty store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-cost-corrupt-"));
    const dbPath = path.join(tempDir, "cost.sqlite");
    const sqlite = requireNodeSqlite();
    try {
      fs.writeFileSync(dbPath, "not a sqlite database", "utf8");

      const opened = openSqliteCostEventStore({
        dbPath,
        sqlite,
        now: new Date("2026-05-14T00:00:00.000Z"),
      });

      expect(opened.status).toBe("ok");
      expect(opened.recoveredFromCorrupt).toBe(true);
      expect(opened.store?.list()).toEqual([]);
      expect(fs.readdirSync(tempDir).some((fileName) => fileName.startsWith("cost.sqlite.broken-"))).toBe(true);
      opened.store?.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
