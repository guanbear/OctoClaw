function sortedRouteCandidates(scores = {}) {
  return Object.entries(scores || {})
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
    .slice(0, 2)
    .map(([route, score]) => ({
      route: String(route || ""),
      score: Math.round(Number(score || 0) * 1000) / 1000,
    }));
}

export function buildRouteRecommendation(routeMeta = {}, resolved = {}) {
  const features = routeMeta?.features && typeof routeMeta.features === "object" ? routeMeta.features : {};
  const scores = routeMeta?.scores && typeof routeMeta.scores === "object" ? routeMeta.scores : {};
  const reasonCodes = Array.isArray(routeMeta?.reason_codes) ? routeMeta.reason_codes.map((item) => String(item || "")) : [];
  const protectedLane = String(routeMeta?.protected_lane || "").trim();
  const conflictType = Number(features.repo_activity_hits || 0) > 0
    ? "repo_activity_lookup"
    : String(routeMeta?.semantic_review_reason || "").trim();
  const arbitrationRequired = protectedLane
    ? false
    : Boolean(Number(features.repo_activity_hits || 0) > 0 || routeMeta?.needs_semantic_review);
  const strategy = protectedLane
    ? "none"
    : Number(features.repo_activity_hits || 0) > 0
    ? "rule_fallback"
    : (routeMeta?.needs_semantic_review ? "route_hint_or_future_tiny_judge" : "none");
  const resolvedBy = protectedLane ? "protected_lane" : (Number(features.repo_activity_hits || 0) > 0 ? "rule_fallback" : "base_policy");
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
    reason_codes: reasonCodes.slice(0, 8),
  };
}
