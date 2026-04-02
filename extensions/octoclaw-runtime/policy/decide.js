import { ROUTE_STICKINESS_FILE, loadJson, loadOctoClawConfig, saveJson } from "./config.js";
import { resolveModelAndThinking } from "./model.js";
import { inferRoute } from "./route.js";
import {
  inferWorkerPool as taxonomyInferWorkerPool,
  modelRoleForWorkerPool,
  selectorBandForModelBand,
} from "./taxonomy.js";

const SCHEMA_VERSION = "octoclaw.runtime_policy.decision/v1";
const BRIEF_SCHEMA_VERSION = "octoclaw.brief/v1";
const WORKER_RESULT_SCHEMA_VERSION = "octoclaw.worker_result/v1";
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

function utcNow() {
  return new Date().toISOString();
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMetadata(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
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
  if (!["spawn_single", "spawn_multi"].includes(route)) return {};
  return { ...entry };
}

function stickyContractValue(entry) {
  return String(entry?.work_contract ?? entry?.work_contract_hint ?? "").trim();
}

function stickyApplyLimit(policyCfg) {
  const section = policyCfg?.route_stickiness && typeof policyCfg.route_stickiness === "object" ? policyCfg.route_stickiness : {};
  const parsed = Number(section.max_apply_count ?? 3);
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

function applyStickyRoute(baseRoute, baseWorkContract, features, routeHint, metadata, policyCfg, forcedRoute) {
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
  if (baseRoute === "runner") {
    return { route: baseRoute, stickyState: {}, stickyReasons: [] };
  }

  const stickyRoute = String(sticky.route || "").trim();
  if (!["spawn_single", "spawn_multi"].includes(stickyRoute)) {
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
  if (features.requires_mutation) return false;
  if (features.requires_code_work) return false;
  if (features.parallelizable) return false;
  if (Number(features.estimated_steps || 0) >= 3) return false;
  if (features.requires_research && (Number(features.external_lookup_hits || 0) > 0 || features.requires_writing)) return false;
  return true;
}

function mergeRouteFromHint(baseRoute, features, routeHint) {
  const hintRoute = String(routeHint.route_hint || "").trim();
  if (!hintRoute) return { route: baseRoute, reasonCodes: [] };
  const reasonCodes = [`main_agent_route_hint:${hintRoute}`];

  if (hintRoute === "direct") {
    if (directAllowedFromHint(features)) return { route: "direct", reasonCodes };
    const fallback = features.parallelizable ? "spawn_multi" : "spawn_single";
    reasonCodes.push(`route_hint_veto:direct_to_${fallback}`);
    return { route: fallback, reasonCodes };
  }

  if (hintRoute === "spawn_multi") {
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
  if (stickyState.applied && stickyContract) return stickyContract;
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
  return {
    required: routeHintRequired(routeMeta, forcedRoute, policyCfg),
    hard_gate_applied: hardGateApplied,
    hard_gate_reason: hardGateApplied ? "hard_runner_only" : "",
    submitted,
    source,
    accepted_routes: ["direct", "spawn_single", "spawn_multi"],
    system_preferred_route: baseRoute,
    final_route: finalRoute,
    hint_route: String(routeHint.route_hint || ""),
    hint_work_type: String(routeHint.work_type || ""),
    hint_phase: String(routeHint.phase || ""),
    hint_review_required: Boolean(routeHint.review_required),
    hint_confidence: Number(routeHint.confidence || 0.0),
    hint_reason: String(routeHint.reason || ""),
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

function runtimeSwitchesSummary(policyCfg) {
  const switches = policyCfg?.switches && typeof policyCfg.switches === "object" ? policyCfg.switches : {};
  const routeStickiness = policyCfg?.route_stickiness && typeof policyCfg.route_stickiness === "object" ? policyCfg.route_stickiness : {};
  return {
    policy_enabled: Boolean("enabled" in (policyCfg || {}) ? policyCfg.enabled : true),
    hard_runner_only_enabled: Boolean("hard_runner_only" in switches ? switches.hard_runner_only : true),
    route_hint_required_enabled: Boolean("route_hint_required" in switches ? switches.route_hint_required : true),
    replay_logging_enabled: Boolean("replay_logging" in switches ? switches.replay_logging : true),
    direct_model_override_enabled: Boolean("direct_model_override" in switches ? switches.direct_model_override : true),
    delegation_enforcement_enabled: Boolean("delegation_enforcement" in switches ? switches.delegation_enforcement : true),
    sticky_lane_enabled: Boolean("enabled" in routeStickiness ? routeStickiness.enabled : true),
    ack_followup_enabled: Boolean("ack_followup_enabled" in routeStickiness ? routeStickiness.ack_followup_enabled : true),
  };
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

function toolPolicy(route, dispatchRequired) {
  const blockPatterns = [];
  if (dispatchRequired && ["spawn_single", "spawn_multi"].includes(route)) {
    blockPatterns.push("sessions_spawn", "subagents_send", "manual_subagent_spawn");
  }
  if (route === "runner") {
    blockPatterns.push("manual_long_shell_loop");
  }
  return {
    allow_direct_tools: route === "direct",
    must_delegate_via: dispatchRequired ? "octoclaw_dispatch" : "",
    allowed_control_tools: [
      "octoclaw_policy_decide",
      "octoclaw_route_hint",
      "octoclaw_dispatch",
      "octoclaw_status",
      "octoclaw_task_action",
    ],
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
      skill_bundle: skillPolicy.default_skill_bundle,
      prompt_contract: decision.prompt_contract,
    },
    before_tool_call: {
      enabled: (
        policyEnabled
        && Boolean("before_tool_call" in hooksCfg ? hooksCfg.before_tool_call : true)
        && (routeHintPolicy.required || Boolean("delegation_enforcement" in switchCfg ? switchCfg.delegation_enforcement : true))
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

export function buildDecision(task, { command = "", metadata = {}, forceRoute = "", routeHint = {} } = {}) {
  const normalizedMetadata = normalizeMetadata(metadata);
  const normalizedRouteHint = normalizeRouteHint(routeHint);
  const effectiveForceRoute = VALID_FORCE_ROUTES.has(forceRoute) ? forceRoute : "";
  const routeMeta = applyForcedRoute(inferRoute(task, command), effectiveForceRoute);
  const features = routeMeta.features || {};
  const runtimeCfg = loadOctoClawConfig().runtime_policy || {};
  const baseRoute = String(routeMeta.system_preferred_route ?? routeMeta.route ?? "direct") || "direct";
  const baseWorkContract = String(routeMeta.work_contract_hint || "").trim();
  const stickyResult = applyStickyRoute(
    baseRoute,
    baseWorkContract,
    features,
    normalizedRouteHint,
    normalizedMetadata,
    runtimeCfg,
    effectiveForceRoute,
  );

  let route = stickyResult.route;
  const mergeReasonCodes = [...stickyResult.stickyReasons];
  if (normalizedRouteHint.route_hint) {
    const merged = mergeRouteFromHint(route, features, normalizedRouteHint);
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

  const dispatchRequired = route !== "direct";
  const shouldWait = route === "runner";
  const waitTimeoutSeconds = shouldWait ? Number(routeMeta.wait_timeout_seconds || 0) : 0;
  const routeBudget = budgetPolicy(features, route, workContract, protocol, needsReview);
  const promptPolicy = promptContract(protocol, route, workContract, needsReview);

  const decision = {
    schema_version: SCHEMA_VERSION,
    generated_at: utcNow(),
    route_language_packs: Array.isArray(routeMeta.route_language_packs) ? [...routeMeta.route_language_packs] : [],
    request: {
      task,
      command,
      channel: normalizeChannel(normalizedMetadata.channel || ""),
      session_key: String(normalizedMetadata.session_key || ""),
      metadata: normalizedMetadata,
    },
    route_decision: {
      system_preferred_route: baseRoute,
      route,
      work_contract: workContract,
      work_contract_hint: String(routeMeta.work_contract_hint || ""),
      dispatch_required: dispatchRequired,
      confidence: Number(routeMeta.confidence || 0.0),
      reason: mergedReasonCodes[0] || String(routeMeta.reason || ""),
      reason_codes: mergedReasonCodes,
      scores: routeMeta.scores || {},
      task_class: String(routeMeta.task_class || ""),
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
    prompt_contract: promptPolicy,
    tool_policy: toolPolicy(route, dispatchRequired),
    route_hint_policy: routeHintPolicy,
    runtime_switches: runtimeSwitchesSummary(runtimeCfg),
  };
  decision.summary = summarizeDecision(decision);
  decision.hook_interface = hookInterface(runtimeCfg, decision);
  return decision;
}
