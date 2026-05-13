import type { RouterLiteRequest, RouterLiteRoute, RouterLiteScenario } from "@octoclaw/policy/router-lite";
import { asRecord, asString } from "../util/type-coercion.js";

type UnknownRecord = Record<string, unknown>;

export interface RouterLiteRuntimeSignals {
  channel?: "slack" | "feishu" | "wechat" | "cli" | "unknown";
  contextTokens?: number;
  needsTools?: boolean;
  needsReasoning?: boolean;
  needsStructuredOutput?: boolean;
  minContextTokens?: number;
  statusOrProvenanceRequest?: boolean;
  sessionControlRequest?: boolean;
  explicitOverride?: string;
  scenario?: RouterLiteScenario;
}

interface JudgeSignals {
  route?: string;
  confidence?: number;
  complexity?: string;
  complexityConfidence?: number;
}

export interface BuildRouterLiteRequestInput {
  sessionKey: string;
  turnId: string;
  liveRoute: RouterLiteRoute;
  actualModel?: string;
  judge: JudgeSignals | null;
  runtimeSignals: RouterLiteRuntimeSignals;
  snapshotId: string;
}

const VALID_ROUTES = new Set(["reply", "delegate"]);
const VALID_COMPLEXITIES = new Set(["simple", "normal", "complex", "deep"]);

/**
 * Build a RouterLiteRequest from structured signals.
 * Returns null when judge data is incomplete or invalid.
 * Never reads raw transcript. Never throws.
 */
export function buildRouterLiteRequest(input: BuildRouterLiteRequestInput): RouterLiteRequest | null {
  try {
    const { judge } = input;
    if (!judge) return null;
    if (!judge.route || !VALID_ROUTES.has(judge.route)) return null;
    if (typeof judge.confidence !== "number" || !Number.isFinite(judge.confidence)) return null;
    if (!judge.complexity || !VALID_COMPLEXITIES.has(judge.complexity)) return null;
    if (typeof judge.complexityConfidence !== "number" || !Number.isFinite(judge.complexityConfidence)) return null;

    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      liveRoute: input.liveRoute,
      liveModel: input.actualModel,
      judge: {
        route: judge.route as RouterLiteRoute,
        confidence: judge.confidence,
        complexity: judge.complexity as "simple" | "normal" | "complex" | "deep",
        complexityConfidence: judge.complexityConfidence,
      },
      runtime: {
        channel: input.runtimeSignals.channel,
        contextTokens: input.runtimeSignals.contextTokens,
        needsTools: input.runtimeSignals.needsTools,
        needsReasoning: input.runtimeSignals.needsReasoning,
        needsStructuredOutput: input.runtimeSignals.needsStructuredOutput,
        minContextTokens: input.runtimeSignals.minContextTokens,
        statusOrProvenanceRequest: input.runtimeSignals.statusOrProvenanceRequest,
        sessionControlRequest: input.runtimeSignals.sessionControlRequest,
        explicitOverride: input.runtimeSignals.explicitOverride,
        scenario: input.runtimeSignals.scenario,
      },
      snapshotId: input.snapshotId,
    };
  } catch {
    return null;
  }
}

/**
 * Extract judge signals from a policy decision record.
 */
export function extractJudgeSignals(decision: UnknownRecord, judgeResult?: UnknownRecord | null): JudgeSignals | null {
  // Prefer explicit judge result if available
  const judge = judgeResult ?? asRecord(decision.judge_result) ?? asRecord(decision.llm_judge_result);
  if (!judge || Object.keys(judge).length === 0) {
    // Fall back to route_decision fields
    const routeDecision = asRecord(decision.route_decision);
    const route = asString(routeDecision.route || decision.route);
    const confidence = Number(routeDecision.confidence ?? decision.confidence);
    const complexity = asString(routeDecision.complexity ?? decision.complexity);
    const complexityConfidence = Number(routeDecision.complexity_confidence ?? decision.complexityConfidence);
    if (!route) return null;
    return { route, confidence, complexity, complexityConfidence };
  }

  return {
    route: asString(judge.route),
    confidence: Number(judge.confidence),
    complexity: asString(judge.complexity),
    complexityConfidence: Number(judge.complexity_confidence ?? judge.complexityConfidence),
  };
}

/**
 * Build runtime signals from policy decision and context metadata.
 */
export function buildRuntimeSignalsFromDecision(decision: UnknownRecord, metadata?: UnknownRecord): RouterLiteRuntimeSignals {
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const meta = metadata ?? asRecord(decision.request);
  const sessionKey = asString(meta.session_key || meta.sessionKey);

  const channel = resolveChannel(sessionKey);
  const statusOrProvenanceRequest = routerDecision.request_kind === "status_or_provenance"
    || Boolean(asRecord(meta.conversation_control).status_followup)
    || Boolean(asRecord(meta.conversation_control).provenance_followup);
  const sessionControlRequest = Boolean(asRecord(meta.conversation_control).session_control);

  return {
    channel,
    statusOrProvenanceRequest,
    sessionControlRequest,
    needsTools: Boolean(routeDecision.needs_side_effect || routeDecision.tool_need_hint),
    needsReasoning: Boolean(routeDecision.needs_reasoning),
  };
}

function resolveChannel(sessionKey: string): RouterLiteRuntimeSignals["channel"] {
  const lower = sessionKey.toLowerCase();
  if (lower.includes("slack")) return "slack";
  if (lower.includes("feishu") || lower.includes("lark")) return "feishu";
  if (lower.includes("wechat") || lower.includes("weixin")) return "wechat";
  if (lower.includes("cli") || lower.includes("terminal")) return "cli";
  return "unknown";
}

/**
 * Resolve the actual model from a policy decision.
 */
export function resolveActualModel(decision: UnknownRecord): string | undefined {
  const modelProfile = asString(
    decision.model_profile_final
    || asRecord(decision.model_profile).final_model_id
    || asRecord(decision.model_profile).modelId
    || decision.modelProfile
    || decision.model_id
  );
  return modelProfile || undefined;
}
