function sortedRouteCandidates(scores = {}) {
  return Object.entries(scores || {})
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
    .slice(0, 2)
    .map(([route, score]) => ({
      route: String(route || ""),
      score: Math.round(Number(score || 0) * 1000) / 1000,
    }));
}

export function buildBudgetRecommendation(budgetPolicy = {}, modelPolicy = {}, route = "") {
  const routeName = String(route || "").trim();
  const fallbacks = Array.isArray(modelPolicy?.fallbacks) ? modelPolicy.fallbacks : [];
  const outputBudget = String(budgetPolicy?.budget_cap || "").trim();
  const latencyTarget = String(budgetPolicy?.latency_target || "").trim();
  const maxWorkers = Number(budgetPolicy?.max_workers || 0);
  const retryBudget = Number(budgetPolicy?.retry_cap || 0);
  let outputOk = false;
  let latencyOk = false;
  let workersOk = false;
  const retryOk = retryBudget >= 0;

  if (routeName === "direct") {
    outputOk = outputBudget === "tiny";
    latencyOk = latencyTarget === "interactive";
    workersOk = maxWorkers === 0;
  } else if (routeName === "runner") {
    outputOk = outputBudget === "tiny" || outputBudget === "low";
    latencyOk = latencyTarget === "interactive";
    workersOk = maxWorkers === 1;
  } else if (routeName === "spawn_single") {
    outputOk = outputBudget === "low" || outputBudget === "medium";
    latencyOk = latencyTarget === "background";
    workersOk = maxWorkers === 1;
  } else if (routeName === "spawn_multi") {
    outputOk = outputBudget === "medium" || outputBudget === "high";
    latencyOk = latencyTarget === "background";
    workersOk = maxWorkers >= 2;
  } else {
    outputOk = Boolean(outputBudget);
    latencyOk = Boolean(latencyTarget);
    workersOk = maxWorkers >= 0;
  }

  return {
    schema_version: "octoclaw.budget_recommendation/v1",
    target_model: String(modelPolicy?.selected_model || "").trim(),
    fallback_model: String(fallbacks[0] || "").trim(),
    output_budget: outputBudget,
    retry_budget: retryBudget,
    latency_target: latencyTarget,
    max_workers: maxWorkers,
    reasoning_mode: String(modelPolicy?.reasoning_effort || "").trim(),
    upgrade_allowed: Boolean(budgetPolicy?.upgrade_allowed),
    cost_ceiling: outputBudget,
    consistency: {
      route: routeName,
      route_matches_output_budget: Boolean(outputOk),
      route_matches_latency_target: Boolean(latencyOk),
      route_matches_worker_budget: Boolean(workersOk),
      retry_budget_valid: Boolean(retryOk),
      route_budget_consistent: Boolean(outputOk && latencyOk && workersOk && retryOk),
    },
  };
}

export function buildRouteRecommendation(routeMeta = {}, resolved = {}) {
  const features = routeMeta?.features && typeof routeMeta.features === "object" ? routeMeta.features : {};
  const scores = routeMeta?.scores && typeof routeMeta.scores === "object" ? routeMeta.scores : {};
  const reasonCodes = Array.isArray(routeMeta?.reason_codes) ? routeMeta.reason_codes.map((item) => String(item || "")) : [];
  const protectedLane = String(routeMeta?.protected_lane || "").trim();
  const freshLiveLookup = Boolean(features.fresh_live_lookup);
  const conflictType = freshLiveLookup
    ? ""
    : (Number(features.repo_activity_hits || 0) > 0
      ? "repo_activity_lookup"
      : String(routeMeta?.semantic_review_reason || "").trim());
  const arbitrationRequired = (protectedLane || freshLiveLookup)
    ? false
    : Boolean(Number(features.repo_activity_hits || 0) > 0 || routeMeta?.needs_semantic_review);
  const strategy = (protectedLane || freshLiveLookup)
    ? "none"
    : Number(features.repo_activity_hits || 0) > 0
    ? "rule_fallback"
    : (routeMeta?.needs_semantic_review ? "route_hint_or_future_tiny_judge" : "none");
  const resolvedBy = protectedLane
    ? "protected_lane"
    : (freshLiveLookup ? "base_policy" : (Number(features.repo_activity_hits || 0) > 0 ? "rule_fallback" : "base_policy"));
  const reasonCodeCount = reasonCodes.length;
  const truncatedReasonCodes = reasonCodes.slice(0, 8);
  return {
    schema_version: "octoclaw.route_recommendation/v1",
    recommended_route: String(resolved?.route || routeMeta?.route || routeMeta?.system_preferred_route || "direct"),
    recommended_worker_pool: String(resolved?.worker_pool || ""),
    recommended_work_type: String(resolved?.work_type || ""),
    recommended_phase: String(resolved?.phase || ""),
    recommended_model_band: String(resolved?.model_band || ""),
    protected_lane: protectedLane,
    bypass_delegated_optimization: Boolean(protectedLane),
    work_contract_hint: String(routeMeta?.work_contract_hint || ""),
    top_candidates: sortedRouteCandidates(scores),
    arbitration: {
      required: arbitrationRequired,
      strategy,
      resolved_by: resolvedBy,
      conflict_type: conflictType,
      semantic_review_requested: Boolean(routeMeta?.needs_semantic_review),
      semantic_review_reason: String(routeMeta?.semantic_review_reason || ""),
      score_margin: Math.round(Number(routeMeta?.score_margin || 0) * 1000) / 1000,
      tiny_judge_ready: false,
      fallback_policy: "rule_only",
    },
    reason_codes: truncatedReasonCodes,
    reason_code_count: reasonCodeCount,
    reason_codes_truncated: reasonCodeCount > truncatedReasonCodes.length,
  };
}
