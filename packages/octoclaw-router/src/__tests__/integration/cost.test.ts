import { describe, expect, it, vi } from "vitest";

import type { ModelIntelLite } from "../../decision/contracts.js";
import {
  applyBudgetPlanOnly,
  estimateCostUsd,
  evaluateBudget,
  generateCostReport,
  InMemoryCostEventStore,
  parseCostEventsJsonl,
  renderCostReport,
  type CostEvent,
} from "../../cost/index.js";

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
});
