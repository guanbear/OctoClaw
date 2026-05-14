import fsSync from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

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

export type SqliteProvider = { DatabaseSync: new(location: string, options?: { open?: boolean }) => DatabaseSync } | null;

export interface SqliteCostEventStoreOpenResult {
  status: "ok" | "degraded";
  dbPath: string;
  store?: SqliteCostEventStore;
  error?: string;
  recoveredFromCorrupt?: boolean;
  brokenPath?: string;
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

export class SqliteCostEventStore {
  constructor(private readonly db: DatabaseSync) {}

  record(event: CostEvent): void {
    this.db.prepare(`INSERT INTO cost_events (
      ts,
      session_key,
      turn_id,
      model,
      provider,
      complexity,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      cost_usd,
      route,
      outcome,
      is_plan_call,
      latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.ts,
        event.sessionKey ?? null,
        event.turnId ?? null,
        event.model,
        event.provider ?? null,
        event.complexity ?? null,
        event.inputTokens ?? null,
        event.outputTokens ?? null,
        event.cacheReadTokens ?? null,
        event.cacheWriteTokens ?? null,
        event.costUsd ?? null,
        event.route ?? null,
        event.outcome ?? null,
        event.isPlanCall === undefined ? null : event.isPlanCall ? 1 : 0,
        event.latencyMs ?? null,
      );
  }

  list(): CostEvent[] {
    return this.db.prepare(`SELECT
      ts,
      session_key,
      turn_id,
      model,
      provider,
      complexity,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      cost_usd,
      route,
      outcome,
      is_plan_call,
      latency_ms
    FROM cost_events
    ORDER BY ts ASC, rowid ASC`).all().map(rowToCostEvent);
  }

  close(): void {
    this.db.close();
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

const nodeRequire = createRequire(import.meta.url);

function loadNodeSqlite(): SqliteProvider {
  try {
    return nodeRequire("node:sqlite") as SqliteProvider;
  } catch {
    return null;
  }
}

export function resolveCostSqlitePath(openclawHome = path.join(os.homedir(), ".openclaw")): string {
  return path.join(openclawHome, "octoclaw", "cost.sqlite");
}

export function openSqliteCostEventStore(input: {
  dbPath?: string;
  openclawHome?: string;
  sqlite?: SqliteProvider;
  now?: Date | number;
} = {}): SqliteCostEventStoreOpenResult {
  const dbPath = input.dbPath ?? resolveCostSqlitePath(input.openclawHome);
  const sqlite = input.sqlite !== undefined ? input.sqlite : loadNodeSqlite();
  if (!sqlite) return { status: "degraded", dbPath, error: "node:sqlite module unavailable" };

  try {
    fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (error) {
    return { status: "degraded", dbPath, error: `failed to create cost db directory: ${errorMessage(error)}` };
  }

  const first = tryOpenCostDb(sqlite, dbPath);
  if (first.status === "ok") return first;

  const recovered = recoverCorruptCostDb({ dbPath, sqlite, now: input.now });
  if (recovered.status === "ok") return recovered;
  return first;
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

function tryOpenCostDb(sqlite: NonNullable<SqliteProvider>, dbPath: string): SqliteCostEventStoreOpenResult {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(COST_SQLITE_SCHEMA);
    return { status: "ok", dbPath, store: new SqliteCostEventStore(db) };
  } catch (error) {
    try { db?.close(); } catch {}
    return { status: "degraded", dbPath, error: `failed to open cost sqlite: ${errorMessage(error)}` };
  }
}

function recoverCorruptCostDb(input: {
  dbPath: string;
  sqlite: NonNullable<SqliteProvider>;
  now?: Date | number;
}): SqliteCostEventStoreOpenResult {
  if (!fsSync.existsSync(input.dbPath)) return { status: "degraded", dbPath: input.dbPath, error: "cost sqlite does not exist" };
  const brokenPath = `${input.dbPath}.broken-${timestampForFile(input.now)}`;
  try {
    fsSync.renameSync(input.dbPath, brokenPath);
  } catch (error) {
    return { status: "degraded", dbPath: input.dbPath, error: `failed to rename corrupt cost sqlite: ${errorMessage(error)}` };
  }
  const opened = tryOpenCostDb(input.sqlite, input.dbPath);
  if (opened.status === "ok") return { ...opened, recoveredFromCorrupt: true, brokenPath };
  return opened;
}

function rowToCostEvent(row: Record<string, unknown>): CostEvent {
  const isPlanCall = row.is_plan_call === null || row.is_plan_call === undefined ? undefined : Number(row.is_plan_call) === 1;
  return {
    ts: String(row.ts),
    ...(stringField(row.session_key) ? { sessionKey: stringField(row.session_key) } : {}),
    ...(stringField(row.turn_id) ? { turnId: stringField(row.turn_id) } : {}),
    model: String(row.model),
    ...(stringField(row.provider) ? { provider: stringField(row.provider) } : {}),
    ...(isComplexity(row.complexity) ? { complexity: row.complexity } : {}),
    ...(numberField(row.input_tokens) !== undefined ? { inputTokens: numberField(row.input_tokens) } : {}),
    ...(numberField(row.output_tokens) !== undefined ? { outputTokens: numberField(row.output_tokens) } : {}),
    ...(numberField(row.cache_read_tokens) !== undefined ? { cacheReadTokens: numberField(row.cache_read_tokens) } : {}),
    ...(numberField(row.cache_write_tokens) !== undefined ? { cacheWriteTokens: numberField(row.cache_write_tokens) } : {}),
    ...(numberField(row.cost_usd) !== undefined ? { costUsd: numberField(row.cost_usd) } : {}),
    ...(row.route === "reply" || row.route === "delegate" ? { route: row.route } : {}),
    ...(row.outcome === "success" || row.outcome === "failure" || row.outcome === "timeout" ? { outcome: row.outcome } : {}),
    ...(isPlanCall !== undefined ? { isPlanCall } : {}),
    ...(numberField(row.latency_ms) !== undefined ? { latencyMs: numberField(row.latency_ms) } : {}),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function isComplexity(value: unknown): value is NonNullable<CostEvent["complexity"]> {
  return value === "simple" || value === "normal" || value === "complex" || value === "deep";
}

function timestampForFile(now: Date | number = Date.now()): string {
  const date = now instanceof Date ? now : new Date(now);
  return date.toISOString().replace(/[:.]/gu, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
