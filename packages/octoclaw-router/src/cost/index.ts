export const COST_SQLITE_PATH = "~/.openclaw/octoclaw/cost.sqlite";

export const COST_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_events (
  ts TEXT NOT NULL,
  session_key TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  complexity TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  route TEXT,
  outcome TEXT,
  is_plan_call INTEGER,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cost_ts ON cost_events(ts);
CREATE INDEX IF NOT EXISTS idx_cost_model ON cost_events(model);
`.trim();

export interface CostEvent {
  ts: string;
  sessionKey?: string;
  turnId?: string;
  model: string;
  provider?: string;
  complexity?: "simple" | "normal" | "complex" | "deep";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  route?: "reply" | "delegate";
  outcome?: "success" | "failure" | "timeout";
  isPlanCall?: boolean;
  latencyMs?: number;
}

export class InMemoryCostEventStore {
  private readonly events: CostEvent[] = [];

  record(event: CostEvent): void {
    this.events.push(event);
  }

  list(): CostEvent[] {
    return [...this.events];
  }
}

export interface CostReport {
  period: "1d" | "7d" | "30d" | "month";
  totalUsd: number;
  byModel: Record<string, { totalUsd: number; percent: number }>;
  byComplexity: Record<string, { totalUsd: number; percent: number }>;
  byRoute: Record<string, { totalUsd: number; percent: number }>;
  monthEndPredictionUsd: number;
  anomalies: Array<{ day: string; costUsd: number; reason: string }>;
}

export interface BudgetStatus {
  usedPercent: number;
  notification?: string;
  action?: "warn" | "plan_only";
  reasonCodes: string[];
  ignoredReason?: "budget_exceeded_no_plan";
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, inputUsdPerMTok: number, outputUsdPerMTok: number): number {
  return (inputTokens / 1_000_000) * inputUsdPerMTok + (outputTokens / 1_000_000) * outputUsdPerMTok;
}

export function parseCostEventsJsonl(text: string, options: { warn?: (message: string) => void } = {}): CostEvent[] {
  try {
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CostEvent);
  } catch (error) {
    options.warn?.(`[router-cost] cost store load failed: ${String(error)}`);
    return [];
  }
}

export function generateCostReport(
  events: CostEvent[],
  options: { period?: CostReport["period"]; now?: number } = {},
): CostReport {
  const period = options.period ?? "7d";
  const now = options.now ?? Date.now();
  const filtered = events.filter((event) => isInPeriod(event.ts, period, now));
  const totalUsd = sum(filtered.map((event) => event.costUsd ?? 0));
  const byModel = groupCost(filtered, (event) => event.model, totalUsd);
  const byComplexity = groupCost(filtered, (event) => event.complexity ?? "unknown", totalUsd);
  const byRoute = groupCost(filtered, (event) => event.route ?? "unknown", totalUsd);
  return {
    period,
    totalUsd,
    byModel,
    byComplexity,
    byRoute,
    monthEndPredictionUsd: predictMonthEnd(filtered, now),
    anomalies: detectCostAnomalies(filtered),
  };
}

export function renderCostReport(report: CostReport, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    `OctoClaw Auto Router - Cost Report (${report.period})`,
    `Total spend: $${report.totalUsd.toFixed(2)}`,
    `Predicted month-end: $${report.monthEndPredictionUsd.toFixed(2)}`,
    "By model:",
    ...renderCostGroup(report.byModel),
    "By complexity:",
    ...renderCostGroup(report.byComplexity),
    "By route:",
    ...renderCostGroup(report.byRoute),
  ];
  if (report.anomalies.length > 0) {
    lines.push("Anomalies:");
    for (const anomaly of report.anomalies) lines.push(`  ${anomaly.day}: $${anomaly.costUsd.toFixed(2)} ${anomaly.reason}`);
  }
  return lines.join("\n");
}

export function evaluateBudget(monthlyUsd: number, monthToDateUsd: number): BudgetStatus {
  const usedPercent = monthlyUsd <= 0 ? 0 : (monthToDateUsd / monthlyUsd) * 100;
  if (usedPercent >= 100) {
    return {
      usedPercent,
      action: "plan_only",
      reasonCodes: ["budget_exceeded_plan_only"],
    };
  }
  if (usedPercent >= 80) {
    return {
      usedPercent,
      action: "warn",
      notification: `Budget ${Math.round(usedPercent)}% used ($${Math.round(monthToDateUsd)}/$${Math.round(monthlyUsd)})`,
      reasonCodes: ["budget_warning_80_percent"],
    };
  }
  return { usedPercent, reasonCodes: [] };
}

export function applyBudgetPlanOnly<T extends { plan?: { effectiveCostBand?: string } }>(
  models: T[],
  monthlyUsd: number,
  monthToDateUsd: number,
): { models: T[]; budget: BudgetStatus } {
  const budget = evaluateBudget(monthlyUsd, monthToDateUsd);
  if (budget.action !== "plan_only") return { models, budget };
  const planModels = models.filter((model) => model.plan?.effectiveCostBand === "free_or_sunk");
  return {
    models: planModels,
    budget: planModels.length === 0 ? { ...budget, ignoredReason: "budget_exceeded_no_plan" } : budget,
  };
}

function isInPeriod(ts: string, period: CostReport["period"], now: number): boolean {
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return false;
  if (period === "month") {
    const date = new Date(time);
    const current = new Date(now);
    return date.getUTCFullYear() === current.getUTCFullYear() && date.getUTCMonth() === current.getUTCMonth();
  }
  const days = period === "1d" ? 1 : period === "7d" ? 7 : 30;
  return now - time <= days * 24 * 60 * 60 * 1000;
}

function groupCost(events: CostEvent[], keyFor: (event: CostEvent) => string, totalUsd: number): CostReport["byModel"] {
  const grouped: Record<string, { totalUsd: number; percent: number }> = {};
  for (const event of events) {
    const key = keyFor(event);
    grouped[key] = grouped[key] ?? { totalUsd: 0, percent: 0 };
    grouped[key].totalUsd += event.costUsd ?? 0;
  }
  for (const value of Object.values(grouped)) {
    value.percent = totalUsd === 0 ? 0 : (value.totalUsd / totalUsd) * 100;
  }
  return grouped;
}

function predictMonthEnd(events: CostEvent[], now: number): number {
  if (events.length === 0) return 0;
  const byDay = groupCost(events, (event) => event.ts.slice(0, 10), sum(events.map((event) => event.costUsd ?? 0)));
  const dailyAverage = sum(Object.values(byDay).map((entry) => entry.totalUsd)) / Object.keys(byDay).length;
  void now;
  return dailyAverage * 30;
}

function detectCostAnomalies(events: CostEvent[]): CostReport["anomalies"] {
  const byDay = groupCost(events, (event) => event.ts.slice(0, 10), sum(events.map((event) => event.costUsd ?? 0)));
  const values = Object.entries(byDay).map(([day, entry]) => ({ day, costUsd: entry.totalUsd }));
  if (values.length < 2) return [];
  const average = sum(values.map((value) => value.costUsd)) / values.length;
  return values.filter((value) => value.costUsd > average * 2).map((value) => ({ ...value, reason: "single_day_spike" }));
}

function renderCostGroup(group: CostReport["byModel"]): string[] {
  const entries = Object.entries(group);
  if (entries.length === 0) return ["  (none)"];
  return entries.map(([key, value]) => `  ${key}: $${value.totalUsd.toFixed(2)} (${Math.round(value.percent)}%)`);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
