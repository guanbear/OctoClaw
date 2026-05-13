import { selectShadowRecommendation, writeShadowEvent } from "@octoclaw/policy/router-lite";
import type { RouterLiteShadowEvent, ModelIntelSnapshot } from "@octoclaw/policy/router-lite";
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

    const recommendation = selectShadowRecommendation(request, snapshot);
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
