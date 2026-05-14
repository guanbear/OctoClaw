import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  evaluateBudget,
  generateCostReport,
  openSqliteCostEventStore,
} from "@octoclaw/router";
import { selectShadowRecommendation, writeShadowEvent } from "@octoclaw/router/decision";
import type { RouterLiteShadowEvent, ModelIntelSnapshot } from "@octoclaw/router/decision";
import { parsePromotionDecisionLog } from "@octoclaw/router/promotion";
import type { PromotionDecisionEvent } from "@octoclaw/router/promotion";
import type { BudgetStatus } from "@octoclaw/router";
import { loadRouterLiteSnapshot, resolveShadowEventPath } from "./snapshot-loader.js";
import { buildRouterLiteRequest, extractJudgeSignals, buildRuntimeSignalsFromDecision, resolveActualModel } from "./request-builder.js";
import type { RouterLiteRuntimeSignals } from "./request-builder.js";

type UnknownRecord = Record<string, unknown>;
type LoggerLike = { warn?: (message: string) => void } | null | undefined;

export interface ShadowBridgeInput {
  sessionKey: string;
  turnId: string;
  decision: UnknownRecord;
  judgeResult?: UnknownRecord | null;
  actualModel?: string;
  runtimeSignals?: RouterLiteRuntimeSignals;
  metadata?: UnknownRecord;
  logger?: LoggerLike;
}

const ASSUMED_TOKENS_PER_TASK_MILLIONS = 0.013; // ~10k input + 3k output

function computeCostDelta(
  snapshot: ModelIntelSnapshot,
  actualModel: string | undefined,
  recommendedModel: string | undefined,
): number | undefined {
  if (!actualModel || !recommendedModel || actualModel === recommendedModel) return 0;
  const actual = snapshot.models.find((m) => m.modelKey === actualModel);
  const rec = snapshot.models.find((m) => m.modelKey === recommendedModel);
  const actualPrice = actual?.marketPrice.blendedUsdPerMTok;
  const recPrice = rec?.marketPrice.blendedUsdPerMTok;
  if (actualPrice === undefined || recPrice === undefined) return undefined;
  return (recPrice - actualPrice) * ASSUMED_TOKENS_PER_TASK_MILLIONS;
}

function normalizeLiveRoute(decision: UnknownRecord): "reply" | "delegate" {
  const route = String(
    (decision.route_decision as Record<string, unknown> | undefined)?.route
    || decision.route
    || "reply"
  ).toLowerCase();
  return route === "delegate" ? "delegate" : "reply";
}

function stableTurnId(sessionKey: string): string {
  return `turn-${sessionKey}-${Date.now()}`;
}

function resolvePromotionDecisionsPath(): string {
  const override = process.env.OCTOCLAW_ROUTER_DECISIONS_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".openclaw", "octoclaw", "router-lite", "decisions.log");
}

function loadPromotionDecisions(logger: LoggerLike): PromotionDecisionEvent[] {
  try {
    return parsePromotionDecisionLog(fsSync.readFileSync(resolvePromotionDecisionsPath(), "utf8"));
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      logger?.warn?.(`[router-lite] promotion decisions load failed: ${String(error)}`);
    }
    return [];
  }
}

function resolveOpenclawHome(): string {
  const override = process.env.OPENCLAW_HOME;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".openclaw");
}

function loadBudgetStatus(logger: LoggerLike): BudgetStatus | undefined {
  const openclawHome = resolveOpenclawHome();
  try {
    const raw = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "octoclaw", "router-wizard.json"), "utf8")) as {
      budget?: { monthly?: unknown };
    };
    const monthly = typeof raw.budget?.monthly === "number" ? raw.budget.monthly : Number(raw.budget?.monthly);
    if (!Number.isFinite(monthly)) return undefined;

    const opened = openSqliteCostEventStore({ openclawHome });
    if (opened.status !== "ok" || !opened.store) return undefined;
    try {
      const report = generateCostReport(opened.store.list(), { period: "month" });
      return evaluateBudget(monthly, report.totalUsd);
    } finally {
      opened.store.close();
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      logger?.warn?.(`[router-lite] budget status load failed: ${String(error)}`);
    }
    return undefined;
  }
}

/**
 * Emit a router-lite shadow event comparing actual vs recommended model.
 * 
 * CRITICAL: This function must NEVER throw. Any failure is logged once and
 * silently dropped. The live policy path must not be affected.
 */
export function emitRouterLiteShadowEvent(input: ShadowBridgeInput): void {
  try {
    const snapshot = loadRouterLiteSnapshot();
    if (!snapshot) return; // no snapshot available, skip silently

    const liveRoute = normalizeLiveRoute(input.decision);
    const actualModel = input.actualModel ?? resolveActualModel(input.decision);
    const judgeSignals = extractJudgeSignals(input.decision, input.judgeResult);
    const runtimeSignals = input.runtimeSignals ?? buildRuntimeSignalsFromDecision(input.decision, input.metadata);
    const turnId = input.turnId || stableTurnId(input.sessionKey);

    const request = buildRouterLiteRequest({
      sessionKey: input.sessionKey,
      turnId,
      liveRoute,
      actualModel,
      judge: judgeSignals,
      runtimeSignals,
      snapshotId: snapshot.snapshotId,
    });
    if (!request) return; // incomplete judge data, skip silently

    const promotionDecisions = loadPromotionDecisions(input.logger);
    const budget = loadBudgetStatus(input.logger);
    const recommendation = selectShadowRecommendation(request, snapshot, "balanced", { promotionDecisions, budget });
    const estimatedCostDeltaUsd = computeCostDelta(snapshot, actualModel, recommendation.recommendedModel);

    const event: RouterLiteShadowEvent = {
      event: "router_lite_recommendation",
      turnId,
      snapshotId: snapshot.snapshotId,
      liveRoute,
      actualModel,
      recommendation,
      estimatedCostDeltaUsd,
      qualityGate: "unknown",
      judge: request.judge,
      scenario: recommendation.scenario,
    };

    writeShadowEvent(event, resolveShadowEventPath(), {
      onError: (err) => input.logger?.warn?.(`[router-lite] shadow event write failed: ${String(err)}`),
    });
  } catch (error) {
    // Belt-and-suspenders: never let shadow emission affect the live path.
    input.logger?.warn?.(`[router-lite] shadow bridge error: ${String(error)}`);
  }
}
