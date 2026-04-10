import {
  MODEL_HEALTH_FILE,
  RUNNER_HEALTH_FILE,
  RUNNER_QUEUE_FILE,
  loadJson,
} from "./config.js";

function normalizedText(value) {
  return String(value || "").trim();
}

function normalizeRoute(value) {
  const text = normalizedText(value);
  return text || "direct";
}

function queuePressureBand(queueFile = RUNNER_QUEUE_FILE) {
  const queue = loadJson(queueFile);
  const jobs = Array.isArray(queue?.jobs) ? queue.jobs : [];
  let queued = 0;
  let running = 0;
  for (const job of jobs) {
    const status = normalizedText(job?.status).toLowerCase();
    if (status === "queued") queued += 1;
    if (status === "running") running += 1;
  }
  const active = queued + running;
  if (active >= 8 || queued >= 6) return "high";
  if (active >= 4 || queued >= 3) return "medium";
  if (active >= 1) return "low";
  return "none";
}

function runnerHealthSnapshot(healthFile = RUNNER_HEALTH_FILE) {
  const payload = loadJson(healthFile);
  const workerId = normalizedText(payload?.worker_id);
  const heartbeat = normalizedText(payload?.last_heartbeat_at);
  const reason = normalizedText(payload?.reason) || (workerId ? "ok" : "missing");
  return {
    present: Boolean(workerId),
    worker_id: workerId,
    last_heartbeat_at: heartbeat,
    reason,
    failure_streak: Number(payload?.failure_streak || 0),
    last_job_status: normalizedText(payload?.last_job_status),
  };
}

function quotaPressureBand(modelId, healthFile = MODEL_HEALTH_FILE) {
  const health = loadJson(healthFile);
  const models = health && typeof health === "object" && !Array.isArray(health) ? health.models : null;
  if (!models || typeof models !== "object" || Array.isArray(models)) return "";
  const entry = models[modelId];
  return normalizedText(entry?.quota_pressure).toLowerCase();
}

export function buildRouteOutcome(eventType, decision = {}, payload = {}) {
  const routeDecision = decision?.route_decision && typeof decision.route_decision === "object" ? decision.route_decision : {};
  const routeRecommendation = decision?.route_recommendation && typeof decision.route_recommendation === "object" ? decision.route_recommendation : {};
  const budgetRecommendation = decision?.budget_recommendation && typeof decision.budget_recommendation === "object" ? decision.budget_recommendation : {};
  const autoRouter = decision?.auto_router && typeof decision.auto_router === "object" ? decision.auto_router : {};
  const routerCore = autoRouter?.router_core && typeof autoRouter.router_core === "object" ? autoRouter.router_core : {};
  const request = decision?.request && typeof decision.request === "object" ? decision.request : {};
  const modelPolicy = decision?.model_policy && typeof decision.model_policy === "object" ? decision.model_policy : {};
  const skillPolicy = decision?.skill_policy && typeof decision.skill_policy === "object" ? decision.skill_policy : {};
  const routeHintPolicy = decision?.route_hint_policy && typeof decision.route_hint_policy === "object" ? decision.route_hint_policy : {};
  const promptContract = decision?.prompt_contract && typeof decision.prompt_contract === "object" ? decision.prompt_contract : {};

  const recommendedRoute = normalizeRoute(routeRecommendation.recommended_route || routeDecision.route);
  const resolvedRoute = normalizeRoute(payload.finalRoute || payload.route || recommendedRoute);
  const recommendedModel = normalizedText(budgetRecommendation.target_model || autoRouter?.model_intel?.selected_model || modelPolicy.selected_model);
  const resolvedModel = normalizedText(payload.resolvedModel || payload.model || recommendedModel);
  return {
    schema_version: "octoclaw.route_outcome/v1",
    event_type: normalizedText(eventType),
    execution_contract: recommendedRoute,
    resolved_execution_contract: resolvedRoute,
    agent_scope: normalizedText(routerCore.agent_scope),
    route_class: normalizedText(routerCore.route_class),
    worker_pool: normalizedText(routeDecision.worker_pool),
    phase: normalizedText(routeDecision.phase),
    protocol: normalizedText(routeDecision.protocol),
    profile: normalizedText(modelPolicy.profile),
    skill_bundle: Array.isArray(skillPolicy.default_skill_bundle) ? skillPolicy.default_skill_bundle : [],
    recommended_model: recommendedModel,
    resolved_model: resolvedModel,
    output_budget: normalizedText(budgetRecommendation.output_budget),
    reasoning_mode: normalizedText(budgetRecommendation.reasoning_mode),
    review_required: Boolean(decision?.review_policy?.required),
    artifact_first: Boolean(promptContract.artifact_first),
    handoff_contract: normalizedText(promptContract.handoff_contract),
    reason_codes: Array.isArray(routeDecision.reason_codes) ? routeDecision.reason_codes : [],
    route_source: normalizedText(payload.routeSource || payload.route_source || (routeDecision.protected_lane ? "protected_lane" : "rule")),
    sticky_applied: Boolean("stickyApplied" in payload ? payload.stickyApplied : routeHintPolicy.sticky_applied),
    ack_followup_applied: Boolean("ackFollowupApplied" in payload ? payload.ackFollowupApplied : routeHintPolicy.ack_followup_applied),
    channel: normalizedText(request.channel),
    route_language_packs: Array.isArray(decision?.route_language_packs) ? decision.route_language_packs : [],
    fallback_taken: Boolean(
      payload.fallbackTaken
      || payload.fallback_taken
      || (recommendedModel && resolvedModel && recommendedModel !== resolvedModel)
      || (recommendedRoute && resolvedRoute && recommendedRoute !== resolvedRoute)
    ),
    runner_health_snapshot: runnerHealthSnapshot(),
    queue_pressure_band: queuePressureBand(),
    quota_pressure_band: quotaPressureBand(resolvedModel),
    actual_cost: payload.actualCost ?? payload.actual_cost ?? null,
    actual_latency: payload.actualLatency ?? payload.actual_latency ?? null,
    validation_outcome: normalizedText(payload.validationOutcome || payload.validation_outcome),
  };
}
