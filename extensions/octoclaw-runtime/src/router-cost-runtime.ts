import fsSync from "node:fs";
import path from "node:path";
import {
  evaluateBudget,
  generateCostReport,
  openSqliteCostEventStore,
  type BudgetStatus,
  type CostEvent,
} from "@octoclaw/router";
import { asRecord, type UnknownRecord } from "./util/type-coercion.js";
import { stringValue } from "./extension-entry-shared.js";

type LoggerLike = { warn?: (message: string) => void } | null | undefined;

export interface RuntimeCostBuildInput {
  event: unknown;
  ctx: unknown;
  state: unknown;
  stateKey?: string;
  now?: Date | number;
}

export interface RuntimeCostRecordInput extends RuntimeCostBuildInput {
  openclawHome?: string;
  logger?: LoggerLike;
}

export interface RuntimeCostRecordResult {
  recorded: boolean;
  reason?: string;
  budget?: BudgetStatus;
}

interface RouterWizardBudgetConfig {
  budget?: { monthly: number; currency: "USD" };
}

export function buildRuntimeCostEvent(input: RuntimeCostBuildInput): CostEvent | null {
  const event = asRecord(input.event);
  const ctx = asRecord(input.ctx);
  const state = asRecord(input.state);
  const usage = asRecord(event.usage);
  const decision = asRecord(state.decision || event.decision);
  const routeDecision = asRecord(decision.route_decision || decision.routeDecision);
  const model = firstString(
    event.model,
    event.resolvedModel,
    event.resolved_model,
    event.actualModel,
    event.actual_model,
    state.model,
    state.resolvedModel,
    state.resolved_model,
    state.actualModel,
    state.actual_model,
    decision.model,
    routeDecision.model,
  );
  if (!model) return null;

  const inputTokens = firstNumber(event.inputTokens, event.input_tokens, usage.inputTokens, usage.input_tokens, usage.prompt_tokens, usage.promptTokens);
  const outputTokens = firstNumber(event.outputTokens, event.output_tokens, usage.outputTokens, usage.output_tokens, usage.completion_tokens, usage.completionTokens);
  const costUsd = firstNumber(event.costUsd, event.cost_usd, usage.costUsd, usage.cost_usd);
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return null;

  return {
    ts: toIso(input.now),
    sessionKey: firstString(input.stateKey, ctx.sessionKey, event.sessionKey, state.sessionKey),
    turnId: firstString(ctx.turnId, ctx.turn_id, event.turnId, event.turn_id, state.turnId, state.turn_id),
    model,
    provider: providerForModel(model),
    complexity: firstComplexity(event.complexity, usage.complexity, decision.complexity, routeDecision.complexity),
    inputTokens,
    outputTokens,
    cacheReadTokens: firstNumber(event.cacheReadTokens, event.cache_read_tokens, usage.cacheReadTokens, usage.cache_read_tokens),
    cacheWriteTokens: firstNumber(event.cacheWriteTokens, event.cache_write_tokens, usage.cacheWriteTokens, usage.cache_write_tokens),
    costUsd,
    route: firstRoute(event.route, decision.route, routeDecision.route),
    outcome: firstOutcome(event.outcome, event.status, state.outcome, state.status),
    isPlanCall: firstBoolean(event.isPlanCall, event.is_plan_call, usage.isPlanCall, usage.is_plan_call),
    latencyMs: firstNumber(event.latencyMs, event.latency_ms, usage.latencyMs, usage.latency_ms),
  };
}

export function recordRuntimeCostEventAndBudget(input: RuntimeCostRecordInput): RuntimeCostRecordResult {
  const event = buildRuntimeCostEvent(input);
  if (!event) return { recorded: false, reason: "no_cost_event" };
  const openclawHome = input.openclawHome || stringValue(process.env.OPENCLAW_HOME) || path.join(process.env.HOME || "", ".openclaw");
  const opened = openSqliteCostEventStore({ dbPath: path.join(openclawHome, "octoclaw", "cost.sqlite") });
  if (opened.status !== "ok" || !opened.store) {
    input.logger?.warn?.(`[router-cost] sqlite unavailable: ${opened.error || "unknown"}`);
    return { recorded: false, reason: "sqlite_unavailable" };
  }
  try {
    opened.store.record(event);
    const config = readRouterWizardBudgetConfig(openclawHome);
    if (!config.budget) return { recorded: true };
    const report = generateCostReport(opened.store.list(), { period: "month", now: Date.parse(event.ts) });
    const budget = evaluateBudget(config.budget.monthly, report.totalUsd);
    if (budget.notification) input.logger?.warn?.(`[router-cost] ${budget.notification}`);
    if (budget.action === "plan_only") input.logger?.warn?.(`[router-cost] budget exceeded; sub-agent recommendations should prefer plan-included models`);
    return { recorded: true, budget };
  } catch (error) {
    input.logger?.warn?.(`[router-cost] cost event record failed: ${error instanceof Error ? error.message : String(error)}`);
    return { recorded: false, reason: "record_failed" };
  } finally {
    opened.store.close();
  }
}

function readRouterWizardBudgetConfig(openclawHome: string): RouterWizardBudgetConfig {
  try {
    const raw = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8")) as UnknownRecord;
    const budget = asRecord(raw.budget);
    const monthly = firstNumber(budget.monthly);
    if (monthly === undefined) return {};
    return { budget: { monthly, currency: "USD" } };
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
  }
  return undefined;
}

function firstComplexity(...values: unknown[]): CostEvent["complexity"] | undefined {
  for (const value of values) {
    if (value === "simple" || value === "normal" || value === "complex" || value === "deep") return value;
  }
  return undefined;
}

function firstRoute(...values: unknown[]): CostEvent["route"] | undefined {
  for (const value of values) {
    if (value === "reply" || value === "delegate") return value;
  }
  return undefined;
}

function firstOutcome(...values: unknown[]): CostEvent["outcome"] | undefined {
  for (const value of values) {
    if (value === "success" || value === "completed" || value === "ok") return "success";
    if (value === "failure" || value === "failed" || value === "error") return "failure";
    if (value === "timeout" || value === "timed_out") return "timeout";
  }
  return undefined;
}

function providerForModel(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

function toIso(now: Date | number | undefined): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  return new Date().toISOString();
}
