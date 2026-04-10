import crypto from "node:crypto";
import {
  MODEL_BENCHMARKS_FILE,
  MODEL_CATALOG_FILE,
  MODEL_HEALTH_FILE,
  MODEL_INTEL_SOURCE_STATUS_FILE,
  MODEL_PLAN_STATE_FILE,
  MODEL_POLICY_FILE,
  MODEL_SOURCES_FILE,
  MODEL_SPEED_FILE,
  ROUTE_STICKINESS_FILE,
  loadJson,
  loadOctoClawConfig,
  saveJson,
} from "./config.js";
import { resolveModelAndThinking } from "./model.js";
import { buildBudgetRecommendation, buildRouteRecommendation } from "./recommendation.js";
import { inferRoute } from "./route.js";
import {
  inferWorkerPool as taxonomyInferWorkerPool,
  modelRoleForWorkerPool,
  selectorBandForModelBand,
} from "./taxonomy.js";

const SCHEMA_VERSION = "octoclaw.runtime_policy.decision/v1";
const BRIEF_SCHEMA_VERSION = "octoclaw.brief/v1";
const WORKER_RESULT_SCHEMA_VERSION = "octoclaw.worker_result/v1";
const AUTO_ROUTER_SIGNAL_SCHEMA_VERSION = "octoclaw.auto_router.signal/v1";
const AUTO_ROUTER_CORE_SCHEMA_VERSION = "octoclaw.auto_router.router_core/v1";
const AUTO_ROUTER_BUDGET_SCHEMA_VERSION = "octoclaw.auto_router.budget_planner/v1";
const AUTO_ROUTER_MODEL_INTEL_SCHEMA_VERSION = "octoclaw.auto_router.model_intel/v1";
const AUTO_ROUTER_ADAPTER_SCHEMA_VERSION = "octoclaw.auto_router.adapter/v1";
const AUTO_ROUTER_RECOMMENDATION_SCHEMA_VERSION = "octoclaw.auto_router.recommendation/v1";
const ROUTER_DECISION_V2_SCHEMA_VERSION = "octoclaw.router_decision/v2";
const DEFAULT_MODEL_INTEL_PRECEDENCE = {
  identity: ["operator_override", "curated_local_catalog", "external_model_registry"],
  capabilities: ["operator_override", "external_model_registry", "curated_local_catalog", "built_in_defaults"],
  pricing: ["operator_override", "external_model_registry", "secondary_sync_source", "built_in_defaults"],
  runtime: ["provider_runtime_observation", "operator_override", "built_in_defaults"],
};
const VALID_FORCE_ROUTES = new Set(["", "direct", "runner", "spawn_single", "spawn_multi"]);
const VALID_ROUTE_HINT_ROUTES = new Set(["", "direct", "spawn_single", "spawn_multi"]);
const VALID_ROUTE_HINT_WORK_TYPES = new Set(["", "ops", "research", "code", "review"]);
const WRITER_PATTERNS = [
  String.raw`\b(write|draft|doc|docs|readme|summary|report|memo|proposal|translate|translation)\b`,
  String.raw`(文档|说明|总结|周报|日报|月报|报告|写一版|润色|改写|翻译|飞书|office|ppt|word)`,
];

function roundTo(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function inferRouteClass(route, protectedLane, taskClass) {
  if (protectedLane === "control_observer" || taskClass === "control_observer") return "control_observer";
  if (protectedLane === "session_control" || taskClass === "session_control") return "session_control";
  if (route === "direct") return "main_direct";
  if (route === "runner") return "delegated_runner";
  if (route === "spawn_multi") return "delegated_multi";
  if (route === "spawn_single") return "delegated_single";
  return "unknown";
}

function inferAgentScope(executorType) {
  if (executorType === "main") return "main_agent";
  if (executorType === "runner") return "runner_lane";
  if (executorType === "team") return "team_lane";
  if (executorType === "subagent") return "subagent_lane";
  return "unknown";
}

function utcNow() {
  return new Date().toISOString();
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMetadata(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
}

function normalizedText(value) {
  return String(value || "").trim();
}

function parseUtcTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function looksLikeWriterTask(task, metadata = {}) {
  const text = [String(task || ""), String(metadata.channel || ""), String(metadata.target_format || "")]
    .filter(Boolean)
    .join(" ");
  return WRITER_PATTERNS.some((pattern) => new RegExp(pattern, "iu").test(text));
}

function inferWorkType(task, features, route, metadata = {}) {
  if (route === "runner") return "ops";
  if (looksLikeWriterTask(task, metadata)) return "research";
  if (Number(features.verify_hits || 0) > 0 && !features.requires_mutation) return "review";
  if (features.requires_mutation || features.requires_code_work) return "code";
  if (features.requires_research || features.requires_writing) return "research";
  if (features.high_risk) return "review";
  return "research";
}

function inferPhase(task, features, workType, route, metadata = {}) {
  if (route === "runner") return "inspect";
  if (looksLikeWriterTask(task, metadata)) return "report";
  if (workType === "review") return "verify";
  if (workType === "code") return "implement";
  if (features.requires_writing) return "report";
  if (features.high_risk) return "inspect";
  return "collect";
}

function inferExecutorType(route) {
  if (route === "direct") return "main";
  if (route === "runner") return "runner";
  if (route === "spawn_multi") return "team";
  return "subagent";
}

function normalizeRouteHint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  let routeHint = String(raw.route_hint ?? raw.route ?? "").trim();
  if (!VALID_ROUTE_HINT_ROUTES.has(routeHint)) routeHint = "";
  let workType = String(raw.work_type || "").trim();
  if (!VALID_ROUTE_HINT_WORK_TYPES.has(workType)) workType = "";
  const phase = String(raw.phase || "").trim();
  const reason = String(raw.reason || "").trim();
  const source = String(raw.source || "main_agent").trim() || "main_agent";
  let confidence = Number(raw.confidence || 0.0);
  if (!Number.isFinite(confidence)) confidence = 0.0;
  confidence = Math.max(0.0, Math.min(confidence, 1.0));
  return {
    route_hint: routeHint,
    work_type: workType,
    phase,
    review_required: Boolean(raw.review_required || false),
    confidence: roundTo(confidence),
    reason,
    source,
  };
}

export function routeHintRequired(routeMeta, forcedRoute = "", policyCfg = {}) {
  const switches = policyCfg?.switches && typeof policyCfg.switches === "object" ? policyCfg.switches : {};
  if (!Boolean("route_hint_required" in switches ? switches.route_hint_required : true)) return false;
  if (forcedRoute) return false;
  const reasonCodes = Array.isArray(routeMeta?.reason_codes) ? routeMeta.reason_codes : [];
  if (reasonCodes.includes("hard_runner_only")) return false;
  const route = String(routeMeta?.route ?? routeMeta?.system_preferred_route ?? "").trim();
  if (!route || route === "direct" || route === "runner") return false;
  if (routeMeta?.needs_semantic_review) return true;
  const workContract = String(routeMeta?.work_contract_hint || "").trim();
  if (workContract === "coordinated_work") return true;
  const semanticHits = Number(routeMeta?.features?.semantic_ambiguity_hits || 0);
  if (semanticHits > 0) return true;
  const confidence = Number(routeMeta?.confidence || 0.0);
  const scoreMargin = Number(routeMeta?.score_margin || 0.0);
  if (confidence < 0.72) return true;
  if (scoreMargin < 0.26) return true;
  return false;
}

function loadRouteStickiness(policyCfg, sessionKey) {
  if (!sessionKey) return {};
  const section = policyCfg?.route_stickiness && typeof policyCfg.route_stickiness === "object" ? policyCfg.route_stickiness : {};
  if (!Boolean("enabled" in section ? section.enabled : true)) return {};
  const raw = loadJson(ROUTE_STICKINESS_FILE);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entry = raw[sessionKey];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const ttlMinutes = Math.max(Number(section.ttl_minutes || 180), 0);
  const updatedAt = parseUtcTimestamp(String(entry.updated_at || ""));
  if (!updatedAt) return {};
  if (Date.now() - updatedAt.getTime() > ttlMinutes * 60 * 1000) return {};
  const route = String(entry.route || "").trim();
  if (!["runner", "spawn_single", "spawn_multi"].includes(route)) return {};
  return { ...entry };
}

function stickyContractValue(entry) {
  return String(entry?.work_contract ?? entry?.work_contract_hint ?? "").trim();
}

function stickyApplyLimit(policyCfg) {
  const raw = policyCfg?.route_stickiness;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  const parsed = Number(raw.max_apply_count ?? 3);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 3;
}

function markStickyLaneApplied(sessionKey, entry) {
  if (!sessionKey || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const current = loadJson(ROUTE_STICKINESS_FILE);
  const payload = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  const existing = payload[sessionKey] && typeof payload[sessionKey] === "object" && !Array.isArray(payload[sessionKey])
    ? { ...payload[sessionKey] }
    : { ...entry };
  existing.applied_count = Number(existing.applied_count || 0) + 1;
  existing.last_applied_at = utcNow();
  payload[sessionKey] = existing;
  saveJson(ROUTE_STICKINESS_FILE, payload);
  return existing;
}

function applyStickyRoute(baseRoute, baseWorkContract, features, routeHint, metadata, policyCfg, forcedRoute, laneFeasibility = {}) {
  if (forcedRoute || routeHint.route_hint) return { route: baseRoute, stickyState: {}, stickyReasons: [] };
  const sessionKey = String(metadata.session_key || "").trim();
  const sticky = loadRouteStickiness(policyCfg, sessionKey);
  if (!sticky || Object.keys(sticky).length === 0) return { route: baseRoute, stickyState: {}, stickyReasons: [] };

  const section = policyCfg?.route_stickiness && typeof policyCfg.route_stickiness === "object" ? policyCfg.route_stickiness : {};
  const applyOnFollowupOnly = Boolean("apply_on_followup_only" in section ? section.apply_on_followup_only : true);
  const ackFollowupEnabled = Boolean("ack_followup_enabled" in section ? section.ack_followup_enabled : true);
  const ackFollowupCandidate = Boolean(features.ack_followup_candidate) && ackFollowupEnabled;
  const followupCandidate = Boolean(features.followup_candidate) || ackFollowupCandidate;
  if (applyOnFollowupOnly && !followupCandidate) {
    return { route: baseRoute, stickyState: {}, stickyReasons: [] };
  }
  const stickyRoute = String(sticky.route || "").trim();
  if (!["runner", "spawn_single", "spawn_multi"].includes(stickyRoute)) {
    return { route: baseRoute, stickyState: {}, stickyReasons: [] };
  }
  const stickyContract = stickyContractValue(sticky);
  const maxApplyCount = stickyApplyLimit(policyCfg);
  const appliedCount = Number(sticky.applied_count || 0);
  if (maxApplyCount > 0 && appliedCount >= maxApplyCount) {
    return {
      route: baseRoute,
      stickyState: {
        route: stickyRoute,
        applied: false,
        applied_count: appliedCount,
        decay_blocked: true,
        work_contract: stickyContract,
      },
      stickyReasons: [`route_sticky_decay_blocked:${stickyRoute}`],
    };
  }

  const requireContractMatch = Boolean("require_contract_match" in section ? section.require_contract_match : true);
  if (requireContractMatch && !ackFollowupCandidate) {
    const currentContract = String(baseWorkContract || "").trim();
    if (stickyContract && currentContract && stickyContract !== currentContract) {
      return {
        route: baseRoute,
        stickyState: {
          route: stickyRoute,
          applied: false,
          applied_count: appliedCount,
          goal_shift_blocked: true,
          work_contract: stickyContract,
          current_work_contract: currentContract,
        },
        stickyReasons: [`route_sticky_goal_shift:${stickyContract}_to_${currentContract}`],
      };
    }
  }
  const continuityOverrideAllowed = followupCandidate;
  if (stickyRoute !== baseRoute && !laneIsFeasible(laneFeasibility, stickyRoute) && !continuityOverrideAllowed) {
    return {
      route: baseRoute,
      stickyState: {
        route: stickyRoute,
        applied: false,
        applied_count: appliedCount,
        feasibility_blocked: true,
        work_contract: stickyContract,
      },
      stickyReasons: [`route_sticky_infeasible:${stickyRoute}`],
    };
  }

  const nextSticky = markStickyLaneApplied(sessionKey, sticky);
  const stickyState = {
    route: stickyRoute,
    applied: true,
    applied_count: Number(nextSticky.applied_count ?? appliedCount + 1),
    ack_followup_candidate: ackFollowupCandidate,
    ack_followup_applied: ackFollowupCandidate,
    work_contract: stickyContract,
  };
  const stickyReasons = [ackFollowupCandidate ? `route_ack_followup_inherit:${stickyRoute}` : `route_sticky_lane:${stickyRoute}`];
  if (baseRoute === stickyRoute) {
    return { route: baseRoute, stickyState, stickyReasons };
  }
  return { route: stickyRoute, stickyState, stickyReasons };
}

function directAllowedFromHint(features) {
  if (features.high_risk) return false;
  if (features.requires_tools) return false;
  if (features.requires_external_lookup) return false;
  if (features.requires_mutation) return false;
  if (features.requires_code_work) return false;
  if (features.parallelizable) return false;
  if (Number(features.estimated_steps || 0) >= 3) return false;
  if (features.requires_research && (Number(features.external_lookup_hits || 0) > 0 || features.requires_writing)) return false;
  return true;
}

function laneIsFeasible(laneFeasibility, route) {
  if (!route) return true;
  const entry = laneFeasibility && typeof laneFeasibility === "object" ? laneFeasibility[route] : null;
  if (!entry || typeof entry !== "object") return true;
  return Boolean(entry.feasible);
}

function feasibleHintRoutes(laneFeasibility = {}) {
  return ["direct", "spawn_single", "spawn_multi"].filter((route) => laneIsFeasible(laneFeasibility, route));
}

function routeHintCorrectionPolicy(routeMeta, forcedRoute = "", policyCfg = {}, laneFeasibility = {}) {
  const reasonCodes = Array.isArray(routeMeta?.reason_codes) ? routeMeta.reason_codes : [];
  const protectedLane = String(routeMeta?.protected_lane || "").trim();
  const grayZoneEligible = routeHintRequired(routeMeta, forcedRoute, policyCfg);
  const hardGateApplied = reasonCodes.includes("hard_runner_only");
  let vetoReason = "";
  if (hardGateApplied) vetoReason = "hard_gate";
  else if (protectedLane) vetoReason = "protected_lane";
  else if (!grayZoneEligible) vetoReason = "not_gray_zone";
  return {
    gray_zone_eligible: grayZoneEligible,
    correction_allowed: !vetoReason,
    veto_reason: vetoReason,
    feasible_hint_routes: feasibleHintRoutes(laneFeasibility),
  };
}

function mergeRouteFromHint(baseRoute, features, routeHint, laneFeasibility = {}, correctionPolicy = null) {
  const hintRoute = String(routeHint.route_hint || "").trim();
  if (!hintRoute) return { route: baseRoute, reasonCodes: [] };
  const reasonCodes = [`main_agent_route_hint:${hintRoute}`];
  if (correctionPolicy && !correctionPolicy.correction_allowed) {
    reasonCodes.push(`route_hint_veto:${correctionPolicy.veto_reason || "not_allowed"}`);
    return { route: baseRoute, reasonCodes };
  }

  if (hintRoute === "direct") {
    if (!laneIsFeasible(laneFeasibility, "direct")) {
      reasonCodes.push("route_hint_veto:direct_infeasible");
      return { route: baseRoute, reasonCodes };
    }
    if (directAllowedFromHint(features)) return { route: "direct", reasonCodes };
    const fallback = features.parallelizable ? "spawn_multi" : "spawn_single";
    reasonCodes.push(`route_hint_veto:direct_to_${fallback}`);
    return { route: fallback, reasonCodes };
  }

  if (hintRoute === "spawn_multi") {
    if (!laneIsFeasible(laneFeasibility, "spawn_multi")) {
      const fallback = laneIsFeasible(laneFeasibility, "spawn_single") ? "spawn_single" : baseRoute;
      reasonCodes.push(`route_hint_veto:spawn_multi_infeasible_to_${fallback}`);
      return { route: fallback, reasonCodes };
    }
    if (
      features.parallelizable
      || Number(features.estimated_steps || 0) >= 4
      || features.high_risk
      || (features.requires_research && (features.requires_writing || features.requires_code_work))
    ) {
      return { route: "spawn_multi", reasonCodes };
    }
    reasonCodes.push("route_hint_downgrade:spawn_multi_to_spawn_single");
    return { route: "spawn_single", reasonCodes };
  }

  if (hintRoute === "spawn_single") {
    if (!laneIsFeasible(laneFeasibility, "spawn_single")) {
      reasonCodes.push("route_hint_veto:spawn_single_infeasible");
      return { route: baseRoute, reasonCodes };
    }
    if (features.parallelizable && (features.high_risk || Number(features.estimated_steps || 0) >= 5)) {
      reasonCodes.push("route_hint_upgrade:spawn_single_to_spawn_multi");
      return { route: "spawn_multi", reasonCodes };
    }
    return { route: "spawn_single", reasonCodes };
  }

  return { route: baseRoute, reasonCodes };
}

function mergeWorkType(route, baseWorkType, routeHint) {
  if (route === "runner") return "ops";
  const hintWorkType = String(routeHint.work_type || "").trim();
  if (VALID_ROUTE_HINT_WORK_TYPES.has(hintWorkType) && hintWorkType && hintWorkType !== "ops") return hintWorkType;
  return baseWorkType;
}

function mergePhase(route, basePhase, routeHint) {
  if (route === "runner") return "inspect";
  return String(routeHint.phase || "").trim() || basePhase;
}

function mergeWorkContract(baseWorkContract, route, stickyState = {}) {
  const stickyContract = String(stickyState.work_contract || "").trim();
  if (stickyState.applied && stickyContract && ["runner", "spawn_single", "spawn_multi"].includes(String(stickyState.route || "").trim())) return stickyContract;
  if (route === "direct") return "answer_now";
  if (route === "runner") return "inspect_report";
  if (route === "spawn_multi") return "coordinated_work";
  if (route === "spawn_single") return "deliverable_work";
  return String(baseWorkContract || "").trim();
}

function buildRouteHintPolicy(routeMeta, baseRoute, finalRoute, baseReasonCodes, routeHint, forcedRoute, policyCfg = {}, stickyState = {}) {
  const hardGateApplied = (baseReasonCodes || []).includes("hard_runner_only");
  const submitted = Boolean(routeHint.route_hint);
  let source = "system_preferred";
  if (submitted) source = "main_agent";
  else if (forcedRoute) source = "forced_route";
  else if (stickyState.applied) source = "sticky_lane";
  const laneFeasibility = routeMeta?.lane_feasibility && typeof routeMeta.lane_feasibility === "object" ? routeMeta.lane_feasibility : {};
  const correctionPolicy = routeHintCorrectionPolicy(routeMeta, forcedRoute, policyCfg, laneFeasibility);
  return {
    required: routeHintRequired(routeMeta, forcedRoute, policyCfg),
    hard_gate_applied: hardGateApplied,
    hard_gate_reason: hardGateApplied ? "hard_runner_only" : "",
    submitted,
    source,
    accepted_routes: correctionPolicy.feasible_hint_routes,
    system_preferred_route: baseRoute,
    final_route: finalRoute,
    hint_route: String(routeHint.route_hint || ""),
    hint_work_type: String(routeHint.work_type || ""),
    hint_phase: String(routeHint.phase || ""),
    hint_review_required: Boolean(routeHint.review_required),
    hint_confidence: Number(routeHint.confidence || 0.0),
    hint_reason: String(routeHint.reason || ""),
    gray_zone_eligible: Boolean(correctionPolicy.gray_zone_eligible),
    correction_allowed: Boolean(correctionPolicy.correction_allowed),
    hint_veto_reason: "",
    hint_outcome: submitted ? "pending" : "not_submitted",
    hint_accepted: false,
    hint_effective_route: finalRoute,
    merge_notes: [],
    sticky_applied: Boolean(stickyState.applied),
    sticky_route: String(stickyState.route || ""),
    sticky_work_type: String(stickyState.work_type || ""),
    sticky_work_contract: String(stickyState.work_contract || ""),
    sticky_applied_count: Number(stickyState.applied_count || 0),
    sticky_decay_blocked: Boolean(stickyState.decay_blocked),
    sticky_goal_shift_blocked: Boolean(stickyState.goal_shift_blocked),
    ack_followup_candidate: Boolean(stickyState.ack_followup_candidate),
    ack_followup_applied: Boolean(stickyState.ack_followup_applied),
  };
}

function finalizeRouteHintPolicy(routeHintPolicy, mergeReasonCodes, finalRoute) {
  const policy = routeHintPolicy && typeof routeHintPolicy === "object" ? { ...routeHintPolicy } : {};
  const notes = Array.isArray(mergeReasonCodes) ? mergeReasonCodes : [];
  const veto = notes.find((note) => String(note || "").startsWith("route_hint_veto:"));
  policy.hint_effective_route = finalRoute;
  if (!policy.submitted) {
    policy.hint_outcome = "not_submitted";
    policy.hint_accepted = false;
    policy.hint_veto_reason = "";
    return policy;
  }
  if (veto) {
    policy.hint_outcome = "vetoed";
    policy.hint_accepted = false;
    policy.hint_veto_reason = String(veto).split(":").slice(1).join(":");
    return policy;
  }
  if (String(policy.hint_route || "").trim() && String(policy.hint_route || "").trim() === String(finalRoute || "").trim()) {
    policy.hint_outcome = "accepted";
    policy.hint_accepted = true;
    policy.hint_veto_reason = "";
    return policy;
  }
  if (notes.some((note) => String(note || "").startsWith("route_hint_downgrade:") || String(note || "").startsWith("route_hint_upgrade:"))) {
    policy.hint_outcome = "coerced";
    policy.hint_accepted = false;
    policy.hint_veto_reason = "";
    return policy;
  }
  policy.hint_outcome = "kept_base";
  policy.hint_accepted = false;
  policy.hint_veto_reason = "";
  return policy;
}

function runtimeSwitchesSummary(policyCfg) {
  const switches = policyCfg?.switches && typeof policyCfg.switches === "object" ? policyCfg.switches : {};
  const routeStickiness = policyCfg?.route_stickiness && typeof policyCfg.route_stickiness === "object" ? policyCfg.route_stickiness : {};
  const policyRouter = policyCfg?.policy_router && typeof policyCfg.policy_router === "object" ? policyCfg.policy_router : {};
  const features = policyCfg?.features && typeof policyCfg.features === "object" ? policyCfg.features : {};
  const runnerPool = policyCfg?.runner_pool && typeof policyCfg.runner_pool === "object" ? policyCfg.runner_pool : {};
  return {
    policy_enabled: Boolean("enabled" in (policyCfg || {}) ? policyCfg.enabled : true),
    hard_runner_only_enabled: Boolean("hard_runner_only" in switches ? switches.hard_runner_only : true),
    route_hint_required_enabled: Boolean("route_hint_required" in switches ? switches.route_hint_required : false),
    replay_logging_enabled: Boolean("replay_logging" in switches ? switches.replay_logging : true),
    direct_model_override_enabled: Boolean("direct_model_override" in switches ? switches.direct_model_override : false),
    delegation_enforcement_enabled: Boolean("delegation_enforcement" in switches ? switches.delegation_enforcement : false),
    sticky_lane_enabled: Boolean("enabled" in routeStickiness ? routeStickiness.enabled : true),
    ack_followup_enabled: Boolean("ack_followup_enabled" in routeStickiness ? routeStickiness.ack_followup_enabled : true),
    policy_router_enabled: Boolean("enabled" in policyRouter ? policyRouter.enabled : true),
    policy_router_mode: String(policyRouter.mode || "model_first"),
    policy_judge_live_enabled: Boolean("policy_judge_live" in features ? features.policy_judge_live : true),
    cheap_judge_live_enabled: Boolean("cheap_judge_live" in features ? features.cheap_judge_live : false),
    local_judge_live_enabled: Boolean("local_judge_live" in features ? features.local_judge_live : false),
    runner_pool_enabled: Boolean("runner_pool_enabled" in features ? features.runner_pool_enabled : ("enabled" in runnerPool ? runnerPool.enabled : true)),
    delivery_relay_enabled: Boolean("delivery_relay_enabled" in features ? features.delivery_relay_enabled : true),
    patrol_loop_enabled: Boolean("patrol_loop_enabled" in features ? features.patrol_loop_enabled : false),
  };
}

function normalizeIntentPacket(metadata = {}) {
  const packet = metadata?.intent_packet && typeof metadata.intent_packet === "object" && !Array.isArray(metadata.intent_packet)
    ? metadata.intent_packet
    : {};
  if (Object.keys(packet).length > 0) return { ...packet };
  const conversation = metadata?.conversation_control && typeof metadata.conversation_control === "object" && !Array.isArray(metadata.conversation_control)
    ? metadata.conversation_control
    : {};
  const intentClass = String(conversation.intent_class || conversation.kind || "").trim();
  if (!intentClass) return {};
  return {
    schema_version: "octoclaw.intent_packet/v1-compat",
    available: true,
    intent_class: intentClass,
    confidence: 0.7,
    source: "conversation_control_compat",
    reason_codes: [String(conversation.reason || "conversation_control").trim()].filter(Boolean),
    lookup: {
      scope: String(conversation.lookup_scope || "").trim(),
      project: String(conversation.lookup_project || "").trim(),
      focus: String(conversation.lookup_focus || "").trim(),
      surface_id: String(conversation.surface_id || "").trim(),
      require_fresh_lookup: Boolean(conversation.require_fresh_lookup),
    },
    lane: {
      lane_hint: String(conversation.lane_hint || "").trim(),
      route_hint: String(conversation.route_hint || "").trim(),
      protected_lane: String(conversation.protected_lane || "").trim(),
      grounding_required: Boolean(conversation.require_state_grounding),
    },
  };
}

function stableHash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function stableId(prefix, parts = []) {
  return `${prefix}-${stableHash(parts.map((part) => String(part || "")).join("\u001f"))}`;
}

function firstEnabledPolicyJudge(candidates = {}, preferred = "main_grade_model") {
  const ordered = [
    String(preferred || "").trim(),
    "cheap_model",
    "local_model",
    "main_grade_model",
  ].filter(Boolean);
  for (const key of ordered) {
    const candidate = candidates?.[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && Boolean("enabled" in candidate ? candidate.enabled : false)) {
      return { name: key, config: { ...candidate } };
    }
  }
  return { name: "", config: {} };
}

function buildPolicyRouterState(runtimeCfg = {}, intentPacket = {}, routeMeta = {}) {
  const cfg = runtimeCfg?.policy_router && typeof runtimeCfg.policy_router === "object" && !Array.isArray(runtimeCfg.policy_router)
    ? runtimeCfg.policy_router
    : {};
  const candidates = cfg.candidates && typeof cfg.candidates === "object" && !Array.isArray(cfg.candidates) ? cfg.candidates : {};
  const intentClass = String(intentPacket?.intent_class || "").trim();
  const confidence = Number(intentPacket?.confidence || 0);
  const judgeOn = Array.isArray(cfg.judge_on) ? cfg.judge_on.map((item) => String(item || "").trim()).filter(Boolean) : ["undetermined"];
  const judgeEligible = Boolean(intentPacket?.judge?.eligible || judgeOn.includes(intentClass));
  const selectedJudge = firstEnabledPolicyJudge(candidates, String(cfg.default_judge || "main_grade_model"));
  const deterministicFirst = Boolean("deterministic_first" in cfg ? cfg.deterministic_first : false);
  const enabled = Boolean("enabled" in cfg ? cfg.enabled : true);
  return {
    schema_version: "octoclaw.policy_router/v1",
    enabled,
    mode: String(cfg.mode || "model_first"),
    deterministic_first: deterministicFirst,
    intent_packet: intentPacket && typeof intentPacket === "object" && !Array.isArray(intentPacket) ? { ...intentPacket } : {},
    decision_source: "legacy_planner_until_stateless_judge_live",
    judge: {
      eligible: judgeEligible,
      invoked: false,
      invocation_state: judgeEligible && selectedJudge.name
        ? "eligible_not_invoked_runtime_adapter_pending"
        : "not_needed_for_deterministic_path",
      selected: selectedJudge.name,
      provider: String(selectedJudge.config.provider || selectedJudge.name || ""),
      model: String(selectedJudge.config.model || ""),
      tools: String(selectedJudge.config.tools || "none"),
      prompt_version: "policy-judge-prompt/v1",
      schema_version: "octoclaw.policy_judge.result/v1",
      timeout_ms: Number(cfg.timeout_ms || 1200),
      max_context_chars: Number(cfg.max_context_chars || 2000),
      reason: String(intentPacket?.judge?.reason || "").trim(),
    },
    cache: {
      ttl_seconds: Number(cfg.cache_ttl_seconds || 120),
      key_basis: ["normalized_message", "session_binding", "target_binding", "recent_ledger_hash", "runtime_config_version"],
      hit: false,
      state: "not_checked_in_legacy_planner",
    },
    fallback: {
      fail_closed_route: String(cfg.fail_closed_route || "runner"),
      applied: false,
    },
    route_guard: {
      intent_class: intentClass,
      confidence,
      system_preferred_route: String(routeMeta?.system_preferred_route || routeMeta?.route || ""),
      reason_codes: Array.isArray(routeMeta?.reason_codes) ? [...routeMeta.reason_codes] : [],
    },
  };
}

function requestKindForDecision(route, features = {}, taskClass = "", intentPacket = {}) {
  const intentClass = String(intentPacket?.intent_class || "").trim();
  if (intentClass === "execution_followup" || taskClass === "control_observer") return "execution_followup";
  if (features.fresh_live_lookup || features.bounded_repo_update_lookup || features.bounded_software_update_lookup) return "fresh_external_lookup";
  if (route === "runner" || features.tool_observation_only || features.model_benchmark_candidate) return "surface_query";
  if (route === "direct") return "chat_or_explain";
  return "work_request";
}

function scopeForDecision(route, features = {}, intentPacket = {}, context = {}) {
  const requestKind = String(context.requestKind || "").trim();
  const workType = String(context.workType || "").trim();
  const workContract = String(context.workContract || "").trim();
  const signal = intentPacket?.signals && typeof intentPacket.signals === "object" && !Array.isArray(intentPacket.signals)
    ? intentPacket.signals
    : {};
  const lookupScope = String(features.lookup_scope || "").trim();
  if (lookupScope === "upstream_project") return "upstream_project";
  if (lookupScope === "local_instance") return "local_host";
  if (String(features.target_scope || "") === "remote") return "remote_host";
  if (String(features.target_scope || "") === "local") return "local_host";
  const targets = Array.isArray(signal.target_mentions) ? signal.target_mentions : [];
  if (targets.includes("macmini") || targets.includes("remote") || targets.includes("ai.guanbear.com")) return "remote_host";
  if (targets.includes("local")) return "local_host";
  if (requestKind === "work_request" || ["spawn_single", "spawn_multi"].includes(route)) {
    if (
      workType === "code"
      || workContract === "code_change"
      || features.requires_code_work
      || features.requires_mutation
      || Number(features.implement_hits || 0) > 0
      || Number(features.mutation_hits || 0) > 0
    ) {
      return "current_workspace";
    }
    return "task_context";
  }
  if (requestKind === "execution_followup") return "current_session";
  if (requestKind === "chat_or_explain") return "current_session";
  return "unknown";
}

function targetForDecision(features = {}, scope = "") {
  const explicitTarget = String(features.lookup_project || "").trim();
  if (explicitTarget) return explicitTarget;
  const targetScope = String(features.target_scope || "").trim();
  if (targetScope && targetScope !== "generic") return targetScope;
  if (scope === "current_workspace") return "workspace";
  if (scope === "task_context") return "delegated_task";
  return String(scope || "unknown").trim();
}

function evidenceForDecision(route, features = {}, taskClass = "") {
  if (taskClass === "control_observer") return ["execution_ledger", "taskflow_state"];
  if (features.fresh_live_lookup || features.bounded_repo_update_lookup || features.bounded_software_update_lookup) return ["web_lookup", "execution_ledger"];
  if (route === "runner" && String(features.target_scope || "") === "remote") return ["remote_probe", "execution_ledger"];
  if (route === "runner") return ["local_probe", "execution_ledger"];
  if (route === "direct") return ["none"];
  return ["taskflow_state", "execution_ledger"];
}

function validateRouterDecisionV2(payload = {}) {
  const problems = [];
  const route = String(payload.route || "").trim();
  const scope = String(payload.scope || "").trim();
  const evidence = Array.isArray(payload.evidence_required) ? payload.evidence_required : [];
  if (!["direct", "runner", "spawn_single", "spawn_multi"].includes(route)) problems.push("invalid_route");
  if (!scope) problems.push("missing_scope");
  if (evidence.length === 0) problems.push("missing_evidence_required");
  if (scope === "unknown" && route !== "direct") problems.push("unknown_scope_non_direct_route");
  return {
    passed: problems.length === 0,
    problems,
    validator_version: "router-decision-validator/v1",
  };
}

function buildRouterDecisionV2({
  task,
  route,
  workContract,
  features,
  taskClass,
  workType,
  phase,
  routeBudget,
  preDispatchAck,
  policyRouter,
  intentPacket,
  correlation,
}) {
  const requestKind = requestKindForDecision(route, features, taskClass, intentPacket);
  const scope = scopeForDecision(route, features, intentPacket, {
    requestKind,
    workType,
    workContract,
  });
  const target = targetForDecision(features, scope);
  const evidenceRequired = evidenceForDecision(route, features, taskClass);
  const payload = {
    schema_version: ROUTER_DECISION_V2_SCHEMA_VERSION,
    request_kind: requestKind,
    scope,
    target,
    route,
    work_contract: workContract,
    work_type: workType,
    phase,
    evidence_required: evidenceRequired,
    ack: {
      required: Boolean(preDispatchAck?.required),
      text: String(preDispatchAck?.text || "").trim(),
      kind: preDispatchAck?.required ? "ack" : "none",
    },
    budget: {
      latency_target: String(routeBudget?.latency_target || ""),
      cost_band: String(routeBudget?.budget_cap || ""),
      max_workers: Number(routeBudget?.max_workers || 0),
      retry_cap: Number(routeBudget?.retry_cap || 0),
    },
    confidence: Number(policyRouter?.route_guard?.confidence || 0),
    decision_source: String(policyRouter?.decision_source || "legacy_planner_until_stateless_judge_live"),
    reason_codes: Array.isArray(policyRouter?.route_guard?.reason_codes) ? [...policyRouter.route_guard.reason_codes] : [],
    correlation: correlation && typeof correlation === "object" ? { ...correlation } : {},
    task_preview: normalizedText(task).slice(0, 240),
  };
  payload.validation = validateRouterDecisionV2(payload);
  return payload;
}

function inferProtocol(features, route, workType) {
  if (!["spawn_single", "spawn_multi"].includes(route)) return "normal";
  if (Number(features.estimated_steps || 0) >= 5) return "heavy";
  if (features.parallelizable && Number(features.estimated_steps || 0) >= 3) return "heavy";
  if (features.context_growth === "high" && ["research", "code"].includes(workType)) return "heavy";
  if (Number(features.task_length || 0) >= 320) return "heavy";
  return "normal";
}

function inferUserFacingProfile(workType, phase, route) {
  if (route === "runner") return "ops-fast";
  if (phase === "report") return "writer";
  if (workType === "review") return "review";
  if (workType === "code") return "code";
  return "research";
}

function inferWorkerPool(route, workType) {
  return taxonomyInferWorkerPool(route, workType);
}

function inferModelBand(features, route, workType, protocol) {
  if (protocol === "heavy") return "heavy";
  if (route === "runner") return "fast";
  if (route === "spawn_multi" || features.high_risk) return "strong";
  if (workType === "review") return "strong";
  if (workType === "code" && (features.requires_mutation || Number(features.verify_hits || 0) > 0)) return "strong";
  if (
    features.requires_code_work
    || features.requires_research
    || features.requires_writing
    || Number(features.estimated_steps || 0) >= 3
  ) {
    return "normal";
  }
  if (route === "direct") return "fast";
  return "normal";
}

function resolvePolicyProfile(runtimeCfg, userProfile, selectedModel) {
  const profiles = runtimeCfg?.profiles && typeof runtimeCfg.profiles === "object" ? runtimeCfg.profiles : {};
  if (userProfile && profiles[userProfile]) return userProfile;
  if (userProfile) return userProfile;
  if (selectedModel) {
    const lowered = String(selectedModel).toLowerCase();
    if (["gpt-5.4", "sonnet", "opus"].some((token) => lowered.includes(token))) return "code";
    if (["glm", "minimax", "kimi"].some((token) => lowered.includes(token))) return "research";
  }
  return "research";
}

function reasoningEffortFromConfig(runtimeCfg, modelBand, derivedProfile, modelThinking) {
  if (modelThinking) return modelThinking;
  const profiles = runtimeCfg?.profiles && typeof runtimeCfg.profiles === "object" ? runtimeCfg.profiles : {};
  const profileEntry = profiles[derivedProfile];
  if (profileEntry && typeof profileEntry === "object" && !Array.isArray(profileEntry)) {
    const value = String(profileEntry.reasoning_effort || "").trim();
    if (value) return value;
  }
  const byModelBand = runtimeCfg?.default_reasoning_effort_by_model_band && typeof runtimeCfg.default_reasoning_effort_by_model_band === "object"
    ? runtimeCfg.default_reasoning_effort_by_model_band
    : {};
  const bandValue = String(byModelBand[modelBand] || "").trim();
  if (bandValue) return bandValue;
  if (modelBand === "fast") return "low";
  if (["strong", "heavy"].includes(modelBand)) return "high";
  return "medium";
}

function reviewRequired(features, route, workType, protocol) {
  if (protocol === "heavy") return true;
  if (route === "spawn_multi") return true;
  if (workType === "review") return true;
  if (features.high_risk) return true;
  if (workType === "code" && features.requires_mutation) return true;
  return false;
}

function resolveSkillBundle(policyCfg, workType, profile) {
  const bundles = policyCfg?.skill_bundles && typeof policyCfg.skill_bundles === "object" ? policyCfg.skill_bundles : {};
  const profiles = policyCfg?.profiles && typeof policyCfg.profiles === "object" ? policyCfg.profiles : {};
  const selected = [];
  const profileEntry = profiles[profile];
  if (profileEntry && typeof profileEntry === "object" && !Array.isArray(profileEntry)) {
    const keys = Array.isArray(profileEntry.skill_bundle_keys) ? profileEntry.skill_bundle_keys : [];
    for (const key of keys) {
      const values = Array.isArray(bundles[String(key)]) ? bundles[String(key)] : [];
      selected.push(...values.map((value) => String(value).trim()).filter(Boolean));
    }
  }
  if (selected.length === 0) {
    const values = Array.isArray(bundles[workType]) ? bundles[workType] : [];
    selected.push(...values.map((value) => String(value).trim()).filter(Boolean));
  }
  return [...new Set(selected)];
}

function resolveMergeContract(route, workContract) {
  if (route === "direct") return "none";
  if (route === "runner" || workContract === "inspect_report") return "inspect_report";
  if (route === "spawn_multi" || workContract === "coordinated_work") return "coordinated_compose";
  return "single_worker_result";
}

function resolveHandoffContract(route, workContract) {
  if (route === "direct") return "direct_answer";
  if (route === "runner" || workContract === "inspect_report") return "runner_report";
  if (route === "spawn_multi" || workContract === "coordinated_work") return "team_evidence_handoff";
  return "deliverable_handoff";
}

function budgetPolicy(features, route, workContract, protocol, needsReview) {
  let budgetCap = "low";
  let retryCap = 1;
  let maxWorkers = 1;
  let latencyTarget = "background";
  let interruptibility = "medium";

  if (route === "direct") {
    budgetCap = "tiny";
    retryCap = 0;
    maxWorkers = 0;
    latencyTarget = "interactive";
    interruptibility = "high";
  } else if (route === "runner") {
    budgetCap = "low";
    retryCap = 1;
    maxWorkers = 1;
    latencyTarget = "interactive";
    interruptibility = "high";
  } else if (route === "spawn_multi" || workContract === "coordinated_work") {
    budgetCap = (protocol === "heavy" || features.high_risk) ? "high" : "medium";
    retryCap = 1;
    maxWorkers = String(features.parallel_gain_band || "") === "high" ? 3 : 2;
    latencyTarget = "background";
    interruptibility = "low";
  } else {
    budgetCap = (protocol === "heavy" || needsReview) ? "medium" : "low";
  }

  return {
    budget_cap: budgetCap,
    retry_cap: retryCap,
    max_workers: maxWorkers,
    latency_target: latencyTarget,
    interruptibility,
    upgrade_allowed: route !== "spawn_multi",
  };
}

function promptContract(protocol, route, workContract, needsReview) {
  return {
    work_contract: workContract,
    brief_required: route !== "direct",
    brief_schema_version: BRIEF_SCHEMA_VERSION,
    artifact_first: route !== "direct",
    transcript_to_main: false,
    summary_required: route !== "runner",
    result_schema_version: WORKER_RESULT_SCHEMA_VERSION,
    required_result_fields: ["status", "summary", "artifacts", "report", "risks", "next_step"],
    checkpoint_summary_required: protocol === "heavy",
    direct_reply_allowed: route === "direct",
    final_answer_from_handoff: route !== "direct",
    final_compose_required: route !== "direct",
    user_safe_summary_required: route !== "direct",
    child_results_are_evidence: route === "spawn_multi",
    merge_contract: resolveMergeContract(route, workContract),
    handoff_contract: resolveHandoffContract(route, workContract),
    review_gate_required: Boolean(needsReview),
  };
}

function preDispatchAckPolicy(route, workType, phase, taskClass = "", features = {}) {
  const runnerLookupAck = Boolean(
    route === "runner"
    && taskClass !== "control_observer"
    && Boolean(features.requires_external_lookup || features.bounded_external_inspect || features.bounded_repo_update_lookup || features.fresh_live_lookup)
  );
  const required = (["spawn_single", "spawn_multi"].includes(route) || runnerLookupAck) && taskClass !== "control_observer";
  let text = "我先处理一下，稍后把结果告诉你。";
  if (route === "spawn_multi") {
    text = "我先分派处理一下，稍后把结果汇总给你。";
  } else if (route === "runner" && Boolean(features.bounded_repo_update_lookup || features.bounded_software_update_lookup || features.fresh_live_lookup)) {
    text = "我先看一下最新更新，马上给你结论。";
  } else if (workType === "research") {
    text = "我先查一下，马上给你结论。";
  } else if (workType === "review") {
    text = "我先核对一下，结果回来我帮你收口。";
  } else if (workType === "code" || phase === "implement") {
    text = "我先开一个子任务处理，结果回来我帮你收口。";
  }
  return {
    required,
    style: "brief_status",
    channel_delivery_preferred: required,
    fallback_to_progress_update: required,
    text: required ? text : "",
  };
}

function stateGroundingPolicy(routeMeta, route, taskClass) {
  const protectedLane = normalizedText(routeMeta?.protected_lane);
  const required = Boolean(route === "direct" && taskClass === "control_observer" && protectedLane === "control_observer");
  return {
    required,
    source: required ? "runtime_read_model" : "",
    scope: required ? "task_status_or_provenance" : "",
    target: required ? "explicit_or_recent_task" : "",
    fallback: required ? "ack_uncertainty" : "",
    subject: required ? "latest_execution_turn" : "",
    fallback_to_control_tools: required,
  };
}

function latencyAckPolicy(route, taskClass, features = {}) {
  const required = (
    route === "direct"
    && taskClass !== "control_observer"
    && taskClass !== "session_control"
    && Boolean(features.external_lookup_only || features.bounded_repo_update_lookup)
  );
  const text = !required
    ? ""
    : (features.bounded_repo_update_lookup ? "我先看一下最新更新，马上给你结论。" : "我先查一下，马上给你结论。");
  return {
    required,
    style: "brief_status",
    channel_delivery_preferred: required,
    text,
  };
}

function toolPolicy(route, dispatchRequired, taskClass = "") {
  const blockPatterns = [];
  if (dispatchRequired && ["spawn_single", "spawn_multi"].includes(route)) {
    blockPatterns.push("sessions_spawn", "subagents_send", "manual_subagent_spawn");
  }
  if (route === "runner") {
    blockPatterns.push("manual_long_shell_loop");
  }
  const observerControlTools = [
    "octoclaw_policy_decide",
    "octoclaw_route_hint",
    "octoclaw_status",
    "octoclaw_task_action",
    "session_status",
  ];
  const sessionControlTools = [
    "octoclaw_policy_decide",
    "octoclaw_route_hint",
    "octoclaw_status",
    "session_status",
  ];
  return {
    allow_direct_tools: route === "direct" && !["control_observer", "session_control"].includes(taskClass),
    must_delegate_via: dispatchRequired ? "octoclaw_dispatch" : "",
    allowed_control_tools: [
      "octoclaw_policy_decide",
      "octoclaw_route_hint",
      "octoclaw_dispatch",
      "octoclaw_status",
      "octoclaw_task_action",
    ],
    observer_control_tools: observerControlTools,
    session_control_tools: sessionControlTools,
    control_observer_only: taskClass === "control_observer",
    session_control_only: taskClass === "session_control",
    delegate_first: dispatchRequired,
    block_tool_patterns: blockPatterns,
  };
}

function hookInterface(policyCfg, decision) {
  const hooksCfg = policyCfg?.hooks && typeof policyCfg.hooks === "object" ? policyCfg.hooks : {};
  const policyEnabled = Boolean("enabled" in (policyCfg || {}) ? policyCfg.enabled : true);
  const switchCfg = policyCfg?.switches && typeof policyCfg.switches === "object" ? policyCfg.switches : {};
  const routeDecision = decision.route_decision;
  const modelPolicy = decision.model_policy;
  const skillPolicy = decision.skill_policy;
  const reviewPolicy = decision.review_policy;
  const routeHintPolicy = decision.route_hint_policy;
  const stateGrounding = decision.state_grounding && typeof decision.state_grounding === "object" ? decision.state_grounding : {};

  return {
    before_model_resolve: {
      enabled: (
        policyEnabled
        && Boolean("before_model_resolve" in hooksCfg ? hooksCfg.before_model_resolve : true)
        && Boolean("direct_model_override" in switchCfg ? switchCfg.direct_model_override : true)
      ),
      action: "override_model_selection",
      selected_model: modelPolicy.selected_model,
      profile: modelPolicy.profile,
      reasoning_effort: modelPolicy.reasoning_effort,
      dispatch_required: routeDecision.dispatch_required,
    },
    before_prompt_build: {
      enabled: policyEnabled && Boolean("before_prompt_build" in hooksCfg ? hooksCfg.before_prompt_build : true),
      action: "inject_policy_context",
      policy_context: {
        route: routeDecision.route,
        worker_pool: routeDecision.worker_pool,
        work_type: routeDecision.work_type,
        phase: routeDecision.phase,
        protocol: routeDecision.protocol,
        review_required: reviewPolicy.required,
        route_hint_required: routeHintPolicy.required,
        route_hint_submitted: routeHintPolicy.submitted,
      },
      state_grounding: stateGrounding,
      skill_bundle: skillPolicy.default_skill_bundle,
      prompt_contract: decision.prompt_contract,
    },
    before_tool_call: {
      enabled: (
        policyEnabled
        && Boolean("before_tool_call" in hooksCfg ? hooksCfg.before_tool_call : true)
        && (
          routeDecision.task_class === "control_observer"
          || routeHintPolicy.required
          || Boolean("delegation_enforcement" in switchCfg ? switchCfg.delegation_enforcement : true)
        )
      ),
      action: "enforce_delegation_policy",
      tool_policy: decision.tool_policy,
      delegation_enforcement: Boolean("delegation_enforcement" in switchCfg ? switchCfg.delegation_enforcement : true),
      route_hint_required: routeHintPolicy.required,
      route_hint_submitted: routeHintPolicy.submitted,
      route_hint_tool: "octoclaw_route_hint",
    },
    agent_end: {
      enabled: policyEnabled && Boolean("agent_end" in hooksCfg ? hooksCfg.agent_end : true),
      action: "collect_summary_and_artifacts",
      artifact_first: decision.prompt_contract.artifact_first,
      review_required: reviewPolicy.required,
      final_compose_required: true,
      route_hint_required: routeHintPolicy.required,
      route_hint_submitted: routeHintPolicy.submitted,
    },
  };
}

function applyForcedRoute(routeMeta, forcedRoute) {
  if (!forcedRoute) return routeMeta;
  const payload = { ...routeMeta };
  const reasons = Array.isArray(payload.reason_codes) ? [...payload.reason_codes] : [];
  reasons.unshift(`forced_route:${forcedRoute}`);
  payload.route = forcedRoute;
  payload.reason_codes = reasons;
  payload.reasons = reasons;
  payload.reason = reasons[0] || "";
  payload.dispatch_required = forcedRoute !== "direct";
  payload.main_agent_can_execute_directly = forcedRoute === "direct";
  payload.should_wait = forcedRoute === "runner";
  payload.execution_owner = {
    direct: "main_agent",
    runner: "persistent_runner",
    spawn_single: "subagent",
    spawn_multi: "subagent",
  }[forcedRoute] || payload.execution_owner || "subagent";
  return payload;
}

export function summarizeDecision(decision) {
  const routeDecision = decision?.route_decision || {};
  const modelPolicy = decision?.model_policy || {};
  const route = routeDecision.route || "direct";
  const workerPool = routeDecision.worker_pool || "octoclaw-main";
  const workType = routeDecision.work_type || "";
  const phase = routeDecision.phase || "";
  const profile = modelPolicy.profile || "";
  const modelBand = modelPolicy.model_band || "";
  const model = modelPolicy.selected_model || "";
  return model
    ? `policy=${route} -> ${workerPool} / ${workType}:${phase} / ${modelBand} / profile=${profile} / model=${model}`
    : `policy=${route} -> ${workerPool} / ${workType}:${phase} / ${modelBand} / profile=${profile}`;
}

function inferPolicyPhase(runtimeSwitches = {}) {
  if (runtimeSwitches.route_hint_required_enabled || runtimeSwitches.direct_model_override_enabled) {
    return "enforced";
  }
  if (runtimeSwitches.delegation_enforcement_enabled || runtimeSwitches.sticky_lane_enabled) {
    return "guided";
  }
  return "conservative";
}

function buildAutoRouterPayload(decision) {
  const request = decision?.request && typeof decision.request === "object" ? decision.request : {};
  const routeDecision = decision?.route_decision && typeof decision.route_decision === "object" ? decision.route_decision : {};
  const modelPolicy = decision?.model_policy && typeof decision.model_policy === "object" ? decision.model_policy : {};
  const budget = decision?.budget_policy && typeof decision.budget_policy === "object" ? decision.budget_policy : {};
  const routeHintPolicy = decision?.route_hint_policy && typeof decision.route_hint_policy === "object" ? decision.route_hint_policy : {};
  const prompt = decision?.prompt_contract && typeof decision.prompt_contract === "object" ? decision.prompt_contract : {};
  const tools = decision?.tool_policy && typeof decision.tool_policy === "object" ? decision.tool_policy : {};
  const runtimeSwitches = decision?.runtime_switches && typeof decision.runtime_switches === "object" ? decision.runtime_switches : {};
  const features = decision?.features && typeof decision.features === "object" ? decision.features : {};
  const feedbackSignals = {
    policy_phase: inferPolicyPhase(runtimeSwitches),
    replay_logging_enabled: Boolean(runtimeSwitches.replay_logging_enabled),
    promotion_eligibility: "",
    validation_status: "",
    learning_flags: [],
  };
  const signal = {
    schema_version: AUTO_ROUTER_SIGNAL_SCHEMA_VERSION,
    request: {
      task: normalizedText(request.task),
      command: normalizedText(request.command),
      metadata: request.metadata && typeof request.metadata === "object" ? { ...request.metadata } : {},
      session_key: normalizedText(request.session_key),
      session_origin: normalizedText(request.channel),
    },
    contract: {
      work_contract_hint: normalizedText(routeDecision.work_contract_hint),
      artifact_need: Boolean(routeDecision.artifact_required),
      durable_runtime_need: Boolean(routeDecision.durable_runtime_required),
      parallel_gain: normalizedText(routeDecision.parallel_gain_band),
      risk_level: features.high_risk ? "high" : (decision?.review_policy?.required ? "medium" : "low"),
    },
    continuity: {
      route_hint: normalizedText(routeHintPolicy.hint_route),
      sticky_lane: normalizedText(routeHintPolicy.sticky_route),
      followup_kind: routeHintPolicy.ack_followup_candidate ? "ack" : "",
      session_resume: request.metadata?.resume_context && typeof request.metadata.resume_context === "object"
        ? request.metadata.resume_context
        : {},
    },
    model_signals: {
      model_band_hint: normalizedText(modelPolicy.model_band),
      semantic_model_hint: "",
      expected_cost_band: normalizedText(routeDecision.expected_cost_band),
      expected_latency_ms: Number(routeDecision.expected_latency_ms || 0),
    },
    feedback_signals: feedbackSignals,
  };
  const fallbacks = Array.isArray(modelPolicy.fallbacks) ? modelPolicy.fallbacks : [];
  const selectedModel = normalizedText(modelPolicy.selected_model);
  const routeName = normalizedText(routeDecision.route);
  const outputBudget = normalizedText(budget.budget_cap);
  const latencyTarget = normalizedText(budget.latency_target);
  const maxWorkers = Number(budget.max_workers || 0);
  const retryBudget = Number(budget.retry_cap || 0);
  let outputOk = false;
  let latencyOk = false;
  let workersOk = false;
  let retryOk = retryBudget >= 0;
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
  const consistency = {
    route: routeName,
    route_matches_output_budget: Boolean(outputOk),
    route_matches_latency_target: Boolean(latencyOk),
    route_matches_worker_budget: Boolean(workersOk),
    retry_budget_valid: Boolean(retryOk),
    route_budget_consistent: Boolean(outputOk && latencyOk && workersOk && retryOk),
  };
  const candidateModels = [];
  if (selectedModel) candidateModels.push(selectedModel);
  for (const fallback of fallbacks) {
    const value = normalizedText(fallback);
    if (value && !candidateModels.includes(value)) {
      candidateModels.push(value);
    }
  }
  return {
    schema_version: AUTO_ROUTER_RECOMMENDATION_SCHEMA_VERSION,
    internal_first: true,
    signal,
    router_core: {
      schema_version: AUTO_ROUTER_CORE_SCHEMA_VERSION,
      route: routeName,
      route_class: inferRouteClass(routeName, normalizedText(routeDecision.protected_lane), normalizedText(routeDecision.task_class)),
      agent_scope: inferAgentScope(normalizedText(routeDecision.executor_type)),
      work_contract: normalizedText(routeDecision.work_contract),
      executor_type: normalizedText(routeDecision.executor_type),
      confidence: Number(routeDecision.confidence || 0),
      reason_codes: Array.isArray(routeDecision.reason_codes) ? [...routeDecision.reason_codes] : [],
      required_evidence: decision?.review_policy?.required ? ["validation"] : ["replay"],
      review_required: Boolean(decision?.review_policy?.required),
      next_evaluation_target: decision?.review_policy?.required ? "validation" : "replay",
    },
    budget_planner: {
      schema_version: AUTO_ROUTER_BUDGET_SCHEMA_VERSION,
      target_model: selectedModel,
      fallback_model: normalizedText(fallbacks[0] || ""),
      output_budget: outputBudget,
      retry_budget: retryBudget,
      latency_target: latencyTarget,
      max_workers: maxWorkers,
      reasoning_mode: normalizedText(modelPolicy.reasoning_effort),
      upgrade_allowed: Boolean(budget.upgrade_allowed),
      cost_ceiling: outputBudget,
      consistency,
    },
    model_intel: {
      schema_version: AUTO_ROUTER_MODEL_INTEL_SCHEMA_VERSION,
      selected_model: selectedModel,
      candidate_models: candidateModels,
      provider: selectedModel.includes("/") ? selectedModel.split("/")[0] : "",
      model_band: normalizedText(modelPolicy.model_band),
      selector_band: normalizedText(modelPolicy.selector_band),
      selector_role: normalizedText(modelPolicy.model_selector_role),
      facts_plane:
        modelPolicy.facts_plane && typeof modelPolicy.facts_plane === "object"
          ? JSON.parse(JSON.stringify(modelPolicy.facts_plane))
          : {
              source_status_file: MODEL_INTEL_SOURCE_STATUS_FILE,
              source_precedence: DEFAULT_MODEL_INTEL_PRECEDENCE,
            },
      source_files: {
        catalog: MODEL_CATALOG_FILE,
        policy: MODEL_POLICY_FILE,
        health: MODEL_HEALTH_FILE,
        speed: MODEL_SPEED_FILE,
        plan_state: MODEL_PLAN_STATE_FILE,
        benchmarks: MODEL_BENCHMARKS_FILE,
        sources: MODEL_SOURCES_FILE,
        source_status: MODEL_INTEL_SOURCE_STATUS_FILE,
      },
    },
    adapter: {
      schema_version: AUTO_ROUTER_ADAPTER_SCHEMA_VERSION,
      policy_phase: feedbackSignals.policy_phase,
      merge_contract: normalizedText(prompt.merge_contract),
      handoff_contract: normalizedText(prompt.handoff_contract),
      route_hint_required: Boolean(routeHintPolicy.required),
      dispatch_required: Boolean(tools.dispatch_required),
      control_observer_only: Boolean(tools.control_observer_only),
    },
  };
}

export function buildDecision(task, { command = "", metadata = {}, forceRoute = "", routeHint = {} } = {}) {
  const normalizedMetadata = normalizeMetadata(metadata);
  const intentPacket = normalizeIntentPacket(normalizedMetadata);
  const normalizedRouteHint = normalizeRouteHint(routeHint);
  const effectiveForceRoute = VALID_FORCE_ROUTES.has(forceRoute) ? forceRoute : "";
  const routeMeta = applyForcedRoute(inferRoute(task, command, normalizedMetadata), effectiveForceRoute);
  const features = routeMeta.features || {};
  const laneFeasibility = routeMeta.lane_feasibility && typeof routeMeta.lane_feasibility === "object" ? routeMeta.lane_feasibility : {};
  const runtimeCfg = loadOctoClawConfig().runtime_policy || {};
  const baseRoute = String(routeMeta.system_preferred_route ?? routeMeta.route ?? "direct") || "direct";
  const baseWorkContract = String(routeMeta.work_contract_hint || "").trim();
  const correctionPolicy = routeHintCorrectionPolicy(routeMeta, effectiveForceRoute, runtimeCfg, laneFeasibility);
  const stickyResult = applyStickyRoute(
    baseRoute,
    baseWorkContract,
    features,
    normalizedRouteHint,
    normalizedMetadata,
    runtimeCfg,
    effectiveForceRoute,
    laneFeasibility,
  );

  let route = stickyResult.route;
  const mergeReasonCodes = [...stickyResult.stickyReasons];
  if (normalizedRouteHint.route_hint) {
    const merged = mergeRouteFromHint(route, features, normalizedRouteHint, laneFeasibility, correctionPolicy);
    route = merged.route;
    mergeReasonCodes.push(...merged.reasonCodes);
  }

  const baseWorkType = inferWorkType(task, features, route, normalizedMetadata);
  const workType = mergeWorkType(route, baseWorkType, normalizedRouteHint);
  const basePhase = inferPhase(task, features, workType, route, normalizedMetadata);
  const phase = mergePhase(route, basePhase, normalizedRouteHint);
  const workContract = mergeWorkContract(baseWorkContract, route, stickyResult.stickyState);
  const executorType = inferExecutorType(route);
  const protocol = inferProtocol(features, route, workType);
  const workerPool = inferWorkerPool(route, workType);
  const userProfile = inferUserFacingProfile(workType, phase, route);
  const modelBand = inferModelBand(features, route, workType, protocol);
  const selectorBand = selectorBandForModelBand(modelBand, { route });
  const modelSelectorRole = modelRoleForWorkerPool(workerPool, {
    phase,
    route,
    profile: userProfile,
  });
  const [selectedModel, modelThinking] = resolveModelAndThinking(selectorBand, task, {
    workerPool,
    phase,
    route,
    profile: userProfile,
  });

  const profile = resolvePolicyProfile(runtimeCfg, userProfile, selectedModel);
  const reasoningEffort = reasoningEffortFromConfig(runtimeCfg, modelBand, profile, modelThinking);
  let needsReview = reviewRequired(features, route, workType, protocol);
  if (normalizedRouteHint.review_required) needsReview = true;
  const defaultSkillBundle = resolveSkillBundle(runtimeCfg, workType, profile);

  const baseReasonCodes = Array.isArray(routeMeta.reason_codes) ? [...routeMeta.reason_codes] : [];
  const mergedReasonCodes = [...mergeReasonCodes, ...baseReasonCodes];
  const routeHintPolicy = buildRouteHintPolicy(
    routeMeta,
    baseRoute,
    route,
    baseReasonCodes,
    normalizedRouteHint,
    effectiveForceRoute,
    runtimeCfg,
    stickyResult.stickyState,
  );
  routeHintPolicy.ack_followup_candidate = Boolean(features.ack_followup_candidate || routeHintPolicy.ack_followup_candidate);
  if (stickyResult.stickyState.applied && ["spawn_single", "spawn_multi"].includes(route)) {
    routeHintPolicy.required = false;
    mergeReasonCodes.push("route_hint_suppressed:sticky_lane");
  } else if (routeHintPolicy.ack_followup_applied && ["spawn_single", "spawn_multi"].includes(route)) {
    routeHintPolicy.required = false;
    mergeReasonCodes.push("route_hint_suppressed:ack_followup");
  }
  routeHintPolicy.merge_notes = [...mergeReasonCodes];
  Object.assign(routeHintPolicy, finalizeRouteHintPolicy(routeHintPolicy, mergeReasonCodes, route));

  const dispatchRequired = route !== "direct";
  const shouldWait = route === "runner";
  const waitTimeoutSeconds = shouldWait ? Number(routeMeta.wait_timeout_seconds || 0) : 0;
  const taskClass = String(routeMeta.task_class || "");
  const routeBudget = budgetPolicy(features, route, workContract, protocol, needsReview);
  const promptPolicy = promptContract(protocol, route, workContract, needsReview);
  const preDispatchAck = preDispatchAckPolicy(route, workType, phase, taskClass, features);
  const stateGrounding = stateGroundingPolicy(routeMeta, route, taskClass);
  const latencyAck = latencyAckPolicy(route, taskClass, features);
  const routeRecommendation = buildRouteRecommendation(routeMeta, {
    route,
    worker_pool: workerPool,
    work_type: workType,
    phase,
    model_band: modelBand,
  });
  const budgetRecommendation = buildBudgetRecommendation(
    routeBudget,
    {
      selected_model: selectedModel,
      fallbacks: [],
      reasoning_effort: reasoningEffort,
    },
    route,
  );
  const policyRouter = buildPolicyRouterState(runtimeCfg, intentPacket, routeMeta);
  const turnId = String(normalizedMetadata.turn_id || "").trim()
    || stableId("turn", [
      normalizedMetadata.session_key,
      normalizedMetadata.channel,
      normalizedMetadata.session_id,
      normalizedMetadata.message_id,
      normalizedText(task),
    ]);
  const decisionId = String(normalizedMetadata.decision_id || "").trim()
    || stableId("decision", [
      turnId,
      route,
      workContract,
      Array.isArray(routeMeta.reason_codes) ? routeMeta.reason_codes.join(",") : "",
    ]);
  const correlation = {
    turn_id: turnId,
    decision_id: decisionId,
    session_key: String(normalizedMetadata.session_key || ""),
    session_id: String(normalizedMetadata.session_id || ""),
    delivery_id: "",
    task_id: "",
    runner_job_id: "",
  };
  const routerDecisionV2 = buildRouterDecisionV2({
    task,
    route,
    workContract,
    features,
    taskClass,
    workType,
    phase,
    routeBudget,
    preDispatchAck,
    policyRouter,
    intentPacket,
    correlation,
  });

  const decision = {
    schema_version: SCHEMA_VERSION,
    generated_at: utcNow(),
    features: { ...features },
    route_language_packs: Array.isArray(routeMeta.route_language_packs) ? [...routeMeta.route_language_packs] : [],
    request: {
      task,
      command,
      channel: normalizeChannel(normalizedMetadata.channel || ""),
      session_key: String(normalizedMetadata.session_key || ""),
      metadata: normalizedMetadata,
    },
    correlation,
    intent_packet: intentPacket,
    policy_router: policyRouter,
    router_decision_v2: routerDecisionV2,
    route_decision: {
      system_preferred_route: baseRoute,
      route,
      work_contract: workContract,
      work_contract_hint: String(routeMeta.work_contract_hint || ""),
      contract_kind: String(routeMeta.contract_kind || ""),
      scope_hint: String(routeMeta.scope_hint || ""),
      capability_requirements: Array.isArray(routeMeta.capability_requirements) ? [...routeMeta.capability_requirements] : [],
      lane_feasibility: laneFeasibility,
      feasible_lanes: Array.isArray(routeMeta.feasible_lanes) ? [...routeMeta.feasible_lanes] : [],
      protected_lane: String(routeMeta.protected_lane || ""),
      dispatch_required: dispatchRequired,
      confidence: Number(routeMeta.confidence || 0.0),
      reason: mergedReasonCodes[0] || String(routeMeta.reason || ""),
      reason_codes: mergedReasonCodes,
      scores: routeMeta.scores || {},
      task_class: taskClass,
      executor_type: executorType,
      worker_pool: workerPool,
      work_type: workType,
      phase,
      protocol,
      should_wait: shouldWait,
      wait_timeout_seconds: waitTimeoutSeconds,
      expected_latency_ms: Number(routeMeta.expected_latency_ms || 0),
      expected_cost_band: String(routeMeta.expected_cost_band || ""),
      context_growth_band: String(routeMeta.context_growth_band || ""),
      parallel_gain_band: String(routeMeta.parallel_gain_band || ""),
      artifact_required: Boolean(routeMeta.needs_artifact),
      durable_runtime_required: Boolean(routeMeta.needs_durable_runtime),
    },
    budget_policy: routeBudget,
    model_policy: {
      worker_pool: workerPool,
      model_selector_role: modelSelectorRole,
      selector_band: selectorBand,
      model_band: modelBand,
      selected_model: selectedModel,
      profile,
      reasoning_effort: reasoningEffort,
      fallbacks: [],
    },
    skill_policy: {
      default_skill_bundle: defaultSkillBundle,
      dynamic_discovery_allowed: true,
    },
    review_policy: {
      required: needsReview,
      review_worker_pool: needsReview ? "octoclaw-review" : "",
      review_trigger: needsReview ? "policy_required" : "",
    },
    route_recommendation: routeRecommendation,
    budget_recommendation: budgetRecommendation,
    prompt_contract: promptPolicy,
    pre_dispatch_ack: preDispatchAck,
    state_grounding: stateGrounding,
    latency_ack: latencyAck,
    tool_policy: toolPolicy(route, dispatchRequired, taskClass),
    route_hint_policy: routeHintPolicy,
    runtime_switches: runtimeSwitchesSummary(runtimeCfg),
  };
  decision.summary = summarizeDecision(decision);
  decision.auto_router = buildAutoRouterPayload(decision);
  decision.hook_interface = hookInterface(runtimeCfg, decision);
  return decision;
}
