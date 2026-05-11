import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import { hasBudgetedMainEscalationEvidence } from "./budgeted-main.js";
import { authoritativeDecisionRoute, normalizeLiveRoute } from "./resolve/route-helpers.js";
import { asRecord, asString, type UnknownRecord } from "./util/type-coercion.js";

export interface ExplicitDelegateDispatchRequest {
  requested: boolean;
  reason: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

export function replyDecisionForbidsDispatch(decisionInput: unknown): boolean {
  const decision = asRecord(decisionInput);
  const workContract = asRecord(decision.work_contract);
  const replyContract = asRecord(decision.replyContract ?? decision.reply_contract);
  const toolPolicy = asRecord(decision.tool_policy);
  const forbidden = new Set([
    ...stringArray(workContract.forbiddenTools ?? workContract.forbidden_tools),
    ...stringArray(replyContract.forbiddenTools ?? replyContract.forbidden_tools),
    ...stringArray(toolPolicy.block_tool_patterns),
  ]);
  const route = authoritativeDecisionRoute(decision, "reply");
  return route === "reply" && (forbidden.has("octoclaw_dispatch") || forbidden.has("spawn"));
}

export function explicitDelegateDispatchRequest(input: {
  params: unknown;
  metadata: unknown;
  cachedDecision: unknown;
  dispatchCallImpliesDelegateObjection?: boolean;
}): ExplicitDelegateDispatchRequest {
  const params = asRecord(input.params);
  const metadata = asRecord(input.metadata);
  const forceRoute = asString(params.forceRoute === "auto" ? "" : params.forceRoute);
  if (forceRoute && normalizeLiveRoute(forceRoute, "reply") === "reply") {
    return { requested: false, reason: "" };
  }
  if (forceRoute && normalizeLiveRoute(forceRoute, "reply") === "delegate") {
    return { requested: true, reason: "force_route_delegate" };
  }

  const requestedRoute = normalizeLiveRoute(
    metadata.objection_requested_route
      ?? (metadata.route_request_trusted === true ? metadata.requested_route : undefined),
    "reply",
  );
  if (metadata.route_objection === true && requestedRoute === "delegate" && asString(metadata.objection_reason)) {
    return { requested: true, reason: "route_objection_delegate" };
  }

  const conversationControl = asRecord(metadata.conversation_control);
  if (conversationControl.explicit_delegate_request === true) {
    return { requested: true, reason: "conversation_control_delegate" };
  }

  if (asString(params.model || metadata.model)) {
    return { requested: true, reason: "model_override" };
  }

  const explicitNewWork = (metadata.is_new_work === true || metadata.isNewWork === true)
    && Boolean(asString(metadata.expected_deliverable || metadata.expectedDeliverable || params.task));
  if (explicitNewWork) {
    return { requested: true, reason: "explicit_new_work" };
  }

  if (
    input.dispatchCallImpliesDelegateObjection === true
    && asString(params.task)
    && replyDecisionForbidsDispatch(input.cachedDecision)
  ) {
    return { requested: true, reason: "dispatch_call_under_reply_contract" };
  }

  return { requested: false, reason: "" };
}

export function resolveDispatchTargetRoute(input: {
  params: unknown;
  metadata: unknown;
  cachedDecision: unknown;
  fallbackRoute: unknown;
  dispatchCallImpliesDelegateObjection?: boolean;
}): { route: "reply" | "delegate"; explicitDelegateReason: string } {
  const params = asRecord(input.params);
  const forceRoute = asString(params.forceRoute === "auto" ? "" : params.forceRoute);
  const baseRoute = normalizeLiveRoute(forceRoute || input.fallbackRoute, "reply");
  if (baseRoute === "delegate") {
    return { route: "delegate", explicitDelegateReason: forceRoute ? "force_route_delegate" : "" };
  }

  const explicit = explicitDelegateDispatchRequest(input);
  return explicit.requested
    ? { route: "delegate", explicitDelegateReason: explicit.reason }
    : { route: baseRoute, explicitDelegateReason: "" };
}

export function replySealDelegateDispatchAdmission(input: {
  cachedRouteSeal: RouteSeal | null;
  cachedDecision: UnknownRecord;
  resolvedRoute: string;
  hadCachedDecision: boolean;
  routeSealStates: unknown[];
  params: unknown;
  metadata: unknown;
  dispatchCallImpliesDelegateObjection?: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.hadCachedDecision) return { allowed: false, reason: "" };
  if (input.cachedRouteSeal?.route !== "reply") return { allowed: false, reason: "" };
  if (normalizeLiveRoute(input.resolvedRoute, "reply") !== "delegate") return { allowed: false, reason: "" };
  if (input.routeSealStates.some((candidate) => hasBudgetedMainEscalationEvidence(candidate, input.cachedDecision))) {
    return { allowed: true, reason: "budgeted_main_escalation" };
  }
  const explicit = explicitDelegateDispatchRequest({
    params: input.params,
    metadata: input.metadata,
    cachedDecision: input.cachedDecision,
    dispatchCallImpliesDelegateObjection: input.dispatchCallImpliesDelegateObjection,
  });
  if (explicit.requested) {
    return { allowed: true, reason: explicit.reason };
  }
  return { allowed: false, reason: "" };
}
