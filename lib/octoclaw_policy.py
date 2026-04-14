#!/usr/bin/env python3
"""Structured runtime policy decision entry for OctoClaw.

This module turns task text plus lightweight metadata into a stable decision
object that can later be consumed by:

- OpenClaw runtime hooks / plugins
- dispatch / spawn entrypoints
- ClawTeam task metadata
- UI / observability surfaces

It intentionally does more than return a single model id. The output is a
policy decision with route, worker pool, protocol, profile, review behavior,
skill bundle, and hook recommendations.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from auto_router import build_auto_router_payload, build_budget_recommendation_payload
from model_health_backfill import refresh_model_health_feedback_if_stale
from octoclaw_route import infer_route
from route_recommendation import build_route_recommendation
from octoclaw_spawn import resolve_model_and_thinking
from octopus_config import ROUTE_STICKINESS_FILE, load_json, load_octopus_config, save_json
from runtime_protocol import BRIEF_SCHEMA_VERSION, WORKER_RESULT_SCHEMA_VERSION
from worker_taxonomy import (
    infer_worker_pool as taxonomy_infer_worker_pool,
    model_role_for_worker_pool,
    selector_band_for_model_band,
)

# ═══════════════════════════════════════════════════════════════
# DEPRECATION NOTICE (2026-04-12, R8 cleanup)
# This module's policy decision logic is superseded by the Node runtime
# extension (extensions/octoclaw-runtime/). Only build_decision() is
# called externally (by auto_router.py and dispatch_task.py).
# The functions below (lines ~1-1308) are Python parity code kept for
# eval/replay compatibility. Do NOT add new callers.
# Removal planned for R8+1 after full eval migration.
# ═══════════════════════════════════════════════════════════════

SCHEMA_VERSION = "octoclaw.runtime_policy.decision/v1"
VALID_FORCE_ROUTES = {"", "direct", "runner", "spawn_single", "spawn_multi"}
VALID_ROUTE_HINT_ROUTES = {"", "direct", "spawn_single", "spawn_multi"}
VALID_ROUTE_HINT_WORK_TYPES = {"", "ops", "research", "code", "review"}

WRITER_PATTERNS = [
    r"\b(write|draft|doc|docs|readme|summary|report|memo|proposal|translate|translation)\b",
    r"(文档|说明|总结|周报|日报|月报|报告|写一版|润色|改写|翻译|飞书|office|ppt|word)",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_channel(value: str) -> str:
    return (value or "").strip().lower()


def normalize_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    return {}


def parse_utc_timestamp(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def looks_like_writer_task(task: str, metadata: dict[str, Any] | None = None) -> bool:
    text = " ".join(
        part for part in [
            str(task or ""),
            str((metadata or {}).get("channel", "") or ""),
            str((metadata or {}).get("target_format", "") or ""),
        ]
        if part
    )
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in WRITER_PATTERNS)


def infer_work_type(task: str, features: dict[str, Any], route: str, metadata: dict[str, Any] | None = None) -> str:
    if route == "runner":
        return "ops"
    if looks_like_writer_task(task, metadata):
        return "research"
    if features.get("verify_hits", 0) > 0 and not features.get("requires_mutation"):
        return "review"
    if features.get("requires_mutation") or features.get("requires_code_work"):
        return "code"
    if features.get("requires_research") or features.get("requires_writing"):
        return "research"
    if features.get("high_risk"):
        return "review"
    return "research"


def infer_phase(task: str, features: dict[str, Any], work_type: str, route: str, metadata: dict[str, Any] | None = None) -> str:
    if route == "runner":
        return "inspect"
    if looks_like_writer_task(task, metadata):
        return "report"
    if work_type == "review":
        return "verify"
    if work_type == "code":
        return "implement"
    if features.get("requires_writing"):
        return "report"
    if features.get("high_risk"):
        return "inspect"
    return "collect"


def infer_executor_type(route: str) -> str:
    if route == "direct":
        return "main"
    if route == "runner":
        return "runner"
    if route == "spawn_multi":
        return "team"
    return "subagent"


def normalize_route_hint(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    route_hint = str(raw.get("route_hint", raw.get("route", "")) or "").strip()
    if route_hint not in VALID_ROUTE_HINT_ROUTES:
        route_hint = ""
    work_type = str(raw.get("work_type", "") or "").strip()
    if work_type not in VALID_ROUTE_HINT_WORK_TYPES:
        work_type = ""
    phase = str(raw.get("phase", "") or "").strip()
    reason = str(raw.get("reason", "") or "").strip()
    source = str(raw.get("source", "main_agent") or "main_agent").strip()
    confidence = 0.0
    try:
        confidence = float(raw.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(confidence, 1.0))
    return {
        "route_hint": route_hint,
        "work_type": work_type,
        "phase": phase,
        "review_required": bool(raw.get("review_required", False)),
        "confidence": round(confidence, 3),
        "reason": reason,
        "source": source,
    }


def route_hint_required(route_meta: dict[str, Any], forced_route: str = "", policy_cfg: dict[str, Any] | None = None) -> bool:
    switches = (policy_cfg or {}).get("switches", {}) if isinstance(policy_cfg, dict) else {}
    if not bool(switches.get("route_hint_required", True)):
        return False
    if forced_route:
        return False
    reason_codes = list(route_meta.get("reason_codes", []) or [])
    if "hard_runner_only" in reason_codes:
        return False
    route = str(route_meta.get("route", route_meta.get("system_preferred_route", "")) or "").strip()
    if route in {"", "direct", "runner"}:
        return False
    if bool(route_meta.get("needs_semantic_review")):
        return True
    work_contract = str(route_meta.get("work_contract_hint", "") or "").strip()
    if work_contract == "coordinated_work":
        return True
    features = route_meta.get("features", {})
    if isinstance(features, dict) and int(features.get("semantic_ambiguity_hits", 0) or 0) > 0:
        return True
    try:
        confidence = float(route_meta.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    try:
        score_margin = float(route_meta.get("score_margin", 0.0) or 0.0)
    except (TypeError, ValueError):
        score_margin = 0.0
    if confidence < 0.72:
        return True
    if score_margin < 0.26:
        return True
    return False


def load_route_stickiness(policy_cfg: dict[str, Any], session_key: str) -> dict[str, Any]:
    if not session_key:
        return {}
    section = policy_cfg.get("route_stickiness", {})
    if not isinstance(section, dict) or not section.get("enabled", True):
        return {}
    raw = load_json(ROUTE_STICKINESS_FILE)
    if not isinstance(raw, dict):
        return {}
    entry = raw.get(session_key)
    if not isinstance(entry, dict):
        return {}
    ttl_minutes = int(section.get("ttl_minutes", 180) or 180)
    updated_at = parse_utc_timestamp(str(entry.get("updated_at", "") or ""))
    if updated_at is None:
        return {}
    if datetime.now(timezone.utc) - updated_at > timedelta(minutes=ttl_minutes):
        return {}
    route = str(entry.get("route", "") or "").strip()
    if route not in ("runner", "spawn_single", "spawn_multi"):
        return {}
    return entry


def sticky_contract_value(entry: dict[str, Any]) -> str:
    return str(entry.get("work_contract", entry.get("work_contract_hint", "")) or "").strip()


def sticky_apply_limit(policy_cfg: dict[str, Any]) -> int:
    section = policy_cfg.get("route_stickiness", {})
    if not isinstance(section, dict):
        return 0
    try:
        return max(int(section.get("max_apply_count", 3) or 0), 0)
    except (TypeError, ValueError):
        return 3


def mark_sticky_lane_applied(session_key: str, entry: dict[str, Any]) -> dict[str, Any]:
    if not session_key or not isinstance(entry, dict):
        return entry
    current = load_json(ROUTE_STICKINESS_FILE)
    payload = dict(current) if isinstance(current, dict) else {}
    existing = payload.get(session_key)
    if not isinstance(existing, dict):
        existing = dict(entry)
    applied_count = int(existing.get("applied_count", 0) or 0) + 1
    existing["applied_count"] = applied_count
    existing["last_applied_at"] = utc_now()
    payload[session_key] = existing
    save_json(ROUTE_STICKINESS_FILE, payload)
    return existing


def lane_is_feasible(lane_feasibility: dict[str, Any] | None, route: str) -> bool:
    if not route:
        return True
    if not isinstance(lane_feasibility, dict):
        return True
    entry = lane_feasibility.get(route)
    if not isinstance(entry, dict):
        return True
    return bool(entry.get("feasible"))


def feasible_hint_routes(lane_feasibility: dict[str, Any] | None = None) -> list[str]:
    return [route for route in ("direct", "spawn_single", "spawn_multi") if lane_is_feasible(lane_feasibility, route)]


def route_hint_correction_policy(
    route_meta: dict[str, Any],
    forced_route: str = "",
    policy_cfg: dict[str, Any] | None = None,
    lane_feasibility: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reason_codes = list(route_meta.get("reason_codes", []) or [])
    protected_lane = str(route_meta.get("protected_lane", "") or "").strip()
    gray_zone_eligible = route_hint_required(route_meta, forced_route, policy_cfg)
    hard_gate_applied = "hard_runner_only" in reason_codes
    veto_reason = ""
    if hard_gate_applied:
        veto_reason = "hard_gate"
    elif protected_lane:
        veto_reason = "protected_lane"
    elif not gray_zone_eligible:
        veto_reason = "not_gray_zone"
    return {
        "gray_zone_eligible": gray_zone_eligible,
        "correction_allowed": not bool(veto_reason),
        "veto_reason": veto_reason,
        "feasible_hint_routes": feasible_hint_routes(lane_feasibility),
    }


def apply_sticky_route(
    base_route: str,
    base_work_contract: str,
    features: dict[str, Any],
    route_hint: dict[str, Any],
    metadata: dict[str, Any],
    policy_cfg: dict[str, Any],
    forced_route: str,
    lane_feasibility: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any], list[str]]:
    if forced_route or route_hint.get("route_hint"):
        return base_route, {}, []
    session_key = str(metadata.get("session_key", "") or "").strip()
    sticky = load_route_stickiness(policy_cfg, session_key)
    if not sticky:
        return base_route, {}, []

    section = policy_cfg.get("route_stickiness", {})
    apply_on_followup_only = bool(section.get("apply_on_followup_only", True)) if isinstance(section, dict) else True
    ack_followup_enabled = bool(section.get("ack_followup_enabled", True)) if isinstance(section, dict) else True
    ack_followup_candidate = bool(features.get("ack_followup_candidate")) and ack_followup_enabled
    followup_candidate = bool(features.get("followup_candidate")) or ack_followup_candidate
    if apply_on_followup_only and not followup_candidate:
        return base_route, {}, []
    sticky_route = str(sticky.get("route", "") or "").strip()
    if sticky_route not in ("runner", "spawn_single", "spawn_multi"):
        return base_route, {}, []
    sticky_contract = sticky_contract_value(sticky)
    max_apply_count = sticky_apply_limit(policy_cfg)
    applied_count = int(sticky.get("applied_count", 0) or 0)
    if max_apply_count > 0 and applied_count >= max_apply_count:
        return base_route, {
            "route": sticky_route,
            "applied": False,
            "applied_count": applied_count,
            "decay_blocked": True,
            "work_contract": sticky_contract,
        }, [f"route_sticky_decay_blocked:{sticky_route}"]
    require_contract_match = bool(section.get("require_contract_match", True)) if isinstance(section, dict) else True
    if require_contract_match and not ack_followup_candidate:
        current_contract = str(base_work_contract or "").strip()
        if sticky_contract and current_contract and sticky_contract != current_contract:
            return base_route, {
                "route": sticky_route,
                "applied": False,
                "applied_count": applied_count,
                "goal_shift_blocked": True,
                "work_contract": sticky_contract,
                "current_work_contract": current_contract,
            }, [f"route_sticky_goal_shift:{sticky_contract}_to_{current_contract}"]
    continuity_override_allowed = followup_candidate
    if sticky_route != base_route and not lane_is_feasible(lane_feasibility, sticky_route) and not continuity_override_allowed:
        return base_route, {
            "route": sticky_route,
            "applied": False,
            "applied_count": applied_count,
            "feasibility_blocked": True,
            "work_contract": sticky_contract,
        }, [f"route_sticky_infeasible:{sticky_route}"]
    sticky = mark_sticky_lane_applied(session_key, sticky)
    sticky_state = {
        "route": sticky_route,
        "applied": True,
        "applied_count": int(sticky.get("applied_count", applied_count + 1) or 0),
        "ack_followup_candidate": ack_followup_candidate,
        "ack_followup_applied": ack_followup_candidate,
        "work_contract": sticky_contract,
    }
    sticky_reason = [f"route_ack_followup_inherit:{sticky_route}" if ack_followup_candidate else f"route_sticky_lane:{sticky_route}"]
    if base_route == sticky_route:
        return base_route, sticky_state, sticky_reason
    return sticky_route, sticky_state, sticky_reason


def direct_allowed_from_hint(features: dict[str, Any]) -> bool:
    if features.get("high_risk"):
        return False
    if features.get("requires_tools"):
        return False
    if features.get("requires_external_lookup"):
        return False
    if features.get("requires_mutation"):
        return False
    if features.get("requires_code_work"):
        return False
    if features.get("parallelizable"):
        return False
    if int(features.get("estimated_steps", 0) or 0) >= 3:
        return False
    if features.get("requires_research") and (
        features.get("external_lookup_hits", 0) > 0 or features.get("requires_writing")
    ):
        return False
    return True


def merge_route_from_hint(
    base_route: str,
    features: dict[str, Any],
    route_hint: dict[str, Any],
    lane_feasibility: dict[str, Any] | None = None,
    correction_policy: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    hint_route = str(route_hint.get("route_hint", "") or "").strip()
    if not hint_route:
        return base_route, []

    reason_codes = [f"main_agent_route_hint:{hint_route}"]
    if correction_policy and not bool(correction_policy.get("correction_allowed")):
        reason_codes.append(f"route_hint_veto:{str(correction_policy.get('veto_reason', 'not_allowed') or 'not_allowed')}")
        return base_route, reason_codes
    if hint_route == "direct":
        if not lane_is_feasible(lane_feasibility, "direct"):
            reason_codes.append("route_hint_veto:direct_infeasible")
            return base_route, reason_codes
        if direct_allowed_from_hint(features):
            return "direct", reason_codes
        fallback = "spawn_multi" if features.get("parallelizable") else "spawn_single"
        reason_codes.append(f"route_hint_veto:direct_to_{fallback}")
        return fallback, reason_codes

    if hint_route == "spawn_multi":
        if not lane_is_feasible(lane_feasibility, "spawn_multi"):
            fallback = "spawn_single" if lane_is_feasible(lane_feasibility, "spawn_single") else base_route
            reason_codes.append(f"route_hint_veto:spawn_multi_infeasible_to_{fallback}")
            return fallback, reason_codes
        if (
            features.get("parallelizable")
            or int(features.get("estimated_steps", 0) or 0) >= 4
            or features.get("high_risk")
            or (features.get("requires_research") and (features.get("requires_writing") or features.get("requires_code_work")))
        ):
            return "spawn_multi", reason_codes
        reason_codes.append("route_hint_downgrade:spawn_multi_to_spawn_single")
        return "spawn_single", reason_codes

    if hint_route == "spawn_single":
        if not lane_is_feasible(lane_feasibility, "spawn_single"):
            reason_codes.append("route_hint_veto:spawn_single_infeasible")
            return base_route, reason_codes
        if features.get("parallelizable") and (features.get("high_risk") or int(features.get("estimated_steps", 0) or 0) >= 5):
            reason_codes.append("route_hint_upgrade:spawn_single_to_spawn_multi")
            return "spawn_multi", reason_codes
        return "spawn_single", reason_codes

    return base_route, reason_codes


def merge_work_type(
    route: str,
    base_work_type: str,
    route_hint: dict[str, Any],
) -> str:
    if route == "runner":
        return "ops"
    hint_work_type = str(route_hint.get("work_type", "") or "").strip()
    if hint_work_type in VALID_ROUTE_HINT_WORK_TYPES and hint_work_type and hint_work_type != "ops":
        return hint_work_type
    return base_work_type


def merge_phase(
    route: str,
    base_phase: str,
    route_hint: dict[str, Any],
) -> str:
    if route == "runner":
        return "inspect"
    hint_phase = str(route_hint.get("phase", "") or "").strip()
    if hint_phase:
        return hint_phase
    return base_phase


def merge_work_contract(base_work_contract: str, route: str, sticky_state: dict[str, Any] | None = None) -> str:
    sticky_contract = str((sticky_state or {}).get("work_contract", "") or "").strip()
    sticky_route = str((sticky_state or {}).get("route", "") or "").strip()
    if bool((sticky_state or {}).get("applied")) and sticky_contract and sticky_route in {"runner", "spawn_single", "spawn_multi"}:
        return sticky_contract
    if route == "direct":
        return "answer_now"
    if route == "runner":
        return "inspect_report"
    if route == "spawn_multi":
        return "coordinated_work"
    if route == "spawn_single":
        return "deliverable_work"
    return str(base_work_contract or "").strip()


def build_route_hint_policy(
    route_meta: dict[str, Any],
    base_route: str,
    final_route: str,
    base_reason_codes: list[str],
    route_hint: dict[str, Any],
    forced_route: str,
    policy_cfg: dict[str, Any] | None = None,
    sticky_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    hard_gate_applied = "hard_runner_only" in base_reason_codes
    submitted = bool(route_hint.get("route_hint"))
    required = route_hint_required(route_meta, forced_route, policy_cfg)
    source = "system_preferred"
    if submitted:
        source = "main_agent"
    elif forced_route:
        source = "forced_route"
    elif bool((sticky_state or {}).get("applied")):
        source = "sticky_lane"
    lane_feasibility = route_meta.get("lane_feasibility", {}) if isinstance(route_meta.get("lane_feasibility", {}), dict) else {}
    correction_policy = route_hint_correction_policy(route_meta, forced_route, policy_cfg, lane_feasibility)
    return {
        "required": required,
        "hard_gate_applied": hard_gate_applied,
        "hard_gate_reason": "hard_runner_only" if hard_gate_applied else "",
        "submitted": submitted,
        "source": source,
        "accepted_routes": correction_policy["feasible_hint_routes"],
        "system_preferred_route": base_route,
        "final_route": final_route,
        "hint_route": str(route_hint.get("route_hint", "") or ""),
        "hint_work_type": str(route_hint.get("work_type", "") or ""),
        "hint_phase": str(route_hint.get("phase", "") or ""),
        "hint_review_required": bool(route_hint.get("review_required", False)),
        "hint_confidence": float(route_hint.get("confidence", 0.0) or 0.0),
        "hint_reason": str(route_hint.get("reason", "") or ""),
        "gray_zone_eligible": bool(correction_policy["gray_zone_eligible"]),
        "correction_allowed": bool(correction_policy["correction_allowed"]),
        "hint_veto_reason": "",
        "hint_outcome": "pending" if submitted else "not_submitted",
        "hint_accepted": False,
        "hint_effective_route": final_route,
        "merge_notes": [],
        "sticky_applied": bool((sticky_state or {}).get("applied")),
        "sticky_route": str((sticky_state or {}).get("route", "") or ""),
        "sticky_work_type": str((sticky_state or {}).get("work_type", "") or ""),
        "sticky_work_contract": str((sticky_state or {}).get("work_contract", "") or ""),
        "sticky_applied_count": int((sticky_state or {}).get("applied_count", 0) or 0),
        "sticky_decay_blocked": bool((sticky_state or {}).get("decay_blocked")),
        "sticky_goal_shift_blocked": bool((sticky_state or {}).get("goal_shift_blocked")),
        "ack_followup_candidate": bool((sticky_state or {}).get("ack_followup_candidate")),
        "ack_followup_applied": bool((sticky_state or {}).get("ack_followup_applied")),
    }


def finalize_route_hint_policy(route_hint_policy: dict[str, Any], merge_reason_codes: list[str], final_route: str) -> dict[str, Any]:
    policy = dict(route_hint_policy or {})
    notes = list(merge_reason_codes or [])
    veto = next((note for note in notes if str(note or "").startswith("route_hint_veto:")), "")
    policy["hint_effective_route"] = final_route
    if not bool(policy.get("submitted")):
        policy["hint_outcome"] = "not_submitted"
        policy["hint_accepted"] = False
        policy["hint_veto_reason"] = ""
        return policy
    if veto:
        policy["hint_outcome"] = "vetoed"
        policy["hint_accepted"] = False
        policy["hint_veto_reason"] = str(veto).split(":", 1)[1]
        return policy
    hint_route = str(policy.get("hint_route", "") or "").strip()
    if hint_route and hint_route == str(final_route or "").strip():
        policy["hint_outcome"] = "accepted"
        policy["hint_accepted"] = True
        policy["hint_veto_reason"] = ""
        return policy
    if any(str(note or "").startswith("route_hint_downgrade:") or str(note or "").startswith("route_hint_upgrade:") for note in notes):
        policy["hint_outcome"] = "coerced"
        policy["hint_accepted"] = False
        policy["hint_veto_reason"] = ""
        return policy
    policy["hint_outcome"] = "kept_base"
    policy["hint_accepted"] = False
    policy["hint_veto_reason"] = ""
    return policy


def runtime_switches_summary(policy_cfg: dict[str, Any]) -> dict[str, Any]:
    switches = policy_cfg.get("switches", {}) if isinstance(policy_cfg, dict) else {}
    route_stickiness = policy_cfg.get("route_stickiness", {}) if isinstance(policy_cfg, dict) else {}
    return {
        "policy_enabled": bool(policy_cfg.get("enabled", True)) if isinstance(policy_cfg, dict) else True,
        "hard_runner_only_enabled": bool(switches.get("hard_runner_only", True)),
        "route_hint_required_enabled": bool(switches.get("route_hint_required", True)),
        "replay_logging_enabled": bool(switches.get("replay_logging", True)),
        "direct_model_override_enabled": bool(switches.get("direct_model_override", True)),
        "delegation_enforcement_enabled": bool(switches.get("delegation_enforcement", True)),
        "sticky_lane_enabled": bool(route_stickiness.get("enabled", True)) if isinstance(route_stickiness, dict) else True,
        "ack_followup_enabled": bool(route_stickiness.get("ack_followup_enabled", True)) if isinstance(route_stickiness, dict) else True,
    }


def infer_protocol(features: dict[str, Any], route: str, work_type: str) -> str:
    if route not in ("spawn_single", "spawn_multi"):
        return "normal"
    if features.get("estimated_steps", 0) >= 5:
        return "heavy"
    if features.get("parallelizable") and features.get("estimated_steps", 0) >= 3:
        return "heavy"
    if features.get("context_growth") == "high" and work_type in ("research", "code"):
        return "heavy"
    if features.get("task_length", 0) >= 320:
        return "heavy"
    return "normal"


def infer_user_facing_profile(work_type: str, phase: str, route: str) -> str:
    if route == "runner":
        return "ops-fast"
    if phase == "report":
        return "writer"
    if work_type == "review":
        return "review"
    if work_type == "code":
        return "code"
    return "research"


def infer_worker_pool(route: str, work_type: str) -> str:
    return taxonomy_infer_worker_pool(route, work_type)


def infer_model_band(features: dict[str, Any], route: str, work_type: str, protocol: str) -> str:
    if protocol == "heavy":
        return "heavy"
    if route == "runner":
        return "fast"
    if route == "spawn_multi" or bool(features.get("high_risk")):
        return "strong"
    if work_type == "review":
        return "strong"
    if work_type == "code" and (bool(features.get("requires_mutation")) or int(features.get("verify_hits", 0) or 0) > 0):
        return "strong"
    if (
        bool(features.get("requires_code_work"))
        or bool(features.get("requires_research"))
        or bool(features.get("requires_writing"))
        or int(features.get("estimated_steps", 0) or 0) >= 3
    ):
        return "normal"
    if route == "direct":
        return "fast"
    return "normal"


def resolve_policy_profile(runtime_cfg: dict[str, Any], user_profile: str, selected_model: str) -> str:
    profiles = runtime_cfg.get("profiles", {})
    if isinstance(profiles, dict) and user_profile and user_profile in profiles:
        return user_profile
    if user_profile:
        return user_profile
    if selected_model:
        lowered = selected_model.lower()
        if any(token in lowered for token in ("gpt-5.4", "sonnet", "opus")):
            return "code"
        if any(token in lowered for token in ("glm", "minimax", "kimi")):
            return "research"
    return "research"


def reasoning_effort_from_config(cfg: dict[str, Any], model_band: str, derived_profile: str, model_thinking: str) -> str:
    if model_thinking:
        return model_thinking
    profiles = cfg.get("profiles", {})
    if isinstance(profiles, dict):
        entry = profiles.get(derived_profile)
        if isinstance(entry, dict):
            value = str(entry.get("reasoning_effort", "") or "").strip()
            if value:
                return value
    by_model_band = cfg.get("default_reasoning_effort_by_model_band", {})
    if isinstance(by_model_band, dict):
        value = str(by_model_band.get(model_band, "") or "").strip()
        if value:
            return value
    if model_band == "fast":
        return "low"
    if model_band in {"strong", "heavy"}:
        return "high"
    return "medium"


def review_required(features: dict[str, Any], route: str, work_type: str, protocol: str) -> bool:
    if protocol == "heavy":
        return True
    if route == "spawn_multi":
        return True
    if work_type == "review":
        return True
    if features.get("high_risk"):
        return True
    if work_type == "code" and features.get("requires_mutation"):
        return True
    return False


def resolve_skill_bundle(policy_cfg: dict[str, Any], work_type: str, profile: str) -> list[str]:
    bundles = policy_cfg.get("skill_bundles", {})
    profiles = policy_cfg.get("profiles", {})
    selected: list[str] = []

    if isinstance(profiles, dict):
        profile_entry = profiles.get(profile)
        if isinstance(profile_entry, dict):
            keys = profile_entry.get("skill_bundle_keys", [])
            if isinstance(keys, list):
                for key in keys:
                    values = bundles.get(str(key), []) if isinstance(bundles, dict) else []
                    if isinstance(values, list):
                        selected.extend(str(v) for v in values if str(v).strip())

    if not selected and isinstance(bundles, dict):
        values = bundles.get(work_type, [])
        if isinstance(values, list):
            selected.extend(str(v) for v in values if str(v).strip())

    deduped: list[str] = []
    seen = set()
    for item in selected:
        if item and item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def resolve_merge_contract(route: str, work_contract: str) -> str:
    if route == "direct":
        return "none"
    if route == "runner" or work_contract == "inspect_report":
        return "inspect_report"
    if route == "spawn_multi" or work_contract == "coordinated_work":
        return "coordinated_compose"
    return "single_worker_result"


def resolve_handoff_contract(route: str, work_contract: str) -> str:
    if route == "direct":
        return "direct_answer"
    if route == "runner" or work_contract == "inspect_report":
        return "runner_report"
    if route == "spawn_multi" or work_contract == "coordinated_work":
        return "team_evidence_handoff"
    return "deliverable_handoff"


def budget_policy(features: dict[str, Any], route: str, work_contract: str, protocol: str, needs_review: bool) -> dict[str, Any]:
    if route == "direct":
        budget_cap = "tiny"
        retry_cap = 0
        max_workers = 0
        latency_target = "interactive"
        interruptibility = "high"
    elif route == "runner":
        budget_cap = "low"
        retry_cap = 1
        max_workers = 1
        latency_target = "interactive"
        interruptibility = "high"
    elif route == "spawn_multi" or work_contract == "coordinated_work":
        budget_cap = "high" if protocol == "heavy" or features.get("high_risk") else "medium"
        retry_cap = 1
        max_workers = 3 if str(features.get("parallel_gain_band", "") or "") == "high" else 2
        latency_target = "background"
        interruptibility = "low"
    else:
        budget_cap = "medium" if protocol == "heavy" or needs_review else "low"
        retry_cap = 1
        max_workers = 1
        latency_target = "background"
        interruptibility = "medium"
    return {
        "budget_cap": budget_cap,
        "retry_cap": retry_cap,
        "max_workers": max_workers,
        "latency_target": latency_target,
        "interruptibility": interruptibility,
        "upgrade_allowed": route != "spawn_multi",
    }


def prompt_contract(protocol: str, route: str, work_contract: str, needs_review: bool) -> dict[str, Any]:
    merge_contract = resolve_merge_contract(route, work_contract)
    handoff_contract = resolve_handoff_contract(route, work_contract)
    return {
        "work_contract": work_contract,
        "brief_required": route != "direct",
        "brief_schema_version": BRIEF_SCHEMA_VERSION,
        "artifact_first": route != "direct",
        "transcript_to_main": False,
        "summary_required": route != "runner",
        "result_schema_version": WORKER_RESULT_SCHEMA_VERSION,
        "required_result_fields": ["status", "summary", "artifacts", "report", "risks", "next_step"],
        "checkpoint_summary_required": protocol == "heavy",
        "direct_reply_allowed": route == "direct",
        "final_answer_from_handoff": route != "direct",
        "final_compose_required": route != "direct",
        "user_safe_summary_required": route != "direct",
        "child_results_are_evidence": route == "spawn_multi",
        "merge_contract": merge_contract,
        "handoff_contract": handoff_contract,
        "review_gate_required": bool(needs_review),
    }


def pre_dispatch_ack_policy(
    route: str,
    work_type: str,
    phase: str,
    task_class: str = "",
    features: dict[str, Any] | None = None,
) -> dict[str, Any]:
    feature_flags = features or {}
    runner_lookup_ack = bool(
        route == "runner"
        and task_class != "control_observer"
        and (
            feature_flags.get("requires_external_lookup")
            or feature_flags.get("bounded_external_inspect")
            or feature_flags.get("bounded_repo_update_lookup")
            or feature_flags.get("fresh_live_lookup")
        )
    )
    required = (route in {"spawn_single", "spawn_multi"} or runner_lookup_ack) and task_class != "control_observer"
    text = "我先处理一下，稍后把结果告诉你。"
    if route == "spawn_multi":
        text = "我先分派处理一下，稍后把结果汇总给你。"
    elif route == "runner" and (
        feature_flags.get("fresh_live_lookup")
        or feature_flags.get("bounded_repo_update_lookup")
        or feature_flags.get("bounded_software_update_lookup")
    ):
        text = "我先看一下最新更新，马上给你结论。"
    elif work_type == "research":
        text = "我先查一下，马上给你结论。"
    elif work_type == "review":
        text = "我先核对一下，结果回来我帮你收口。"
    elif work_type == "code" or phase == "implement":
        text = "我先开一个子任务处理，结果回来我帮你收口。"
    return {
        "required": required,
        "style": "brief_status",
        "channel_delivery_preferred": required,
        "fallback_to_progress_update": required,
        "text": text if required else "",
    }


def state_grounding_policy(route_meta: dict[str, Any], route: str, task_class: str) -> dict[str, Any]:
    protected_lane = str(route_meta.get("protected_lane", "") or "").strip()
    required = bool(route == "direct" and task_class == "control_observer" and protected_lane == "control_observer")
    return {
        "required": required,
        "source": "runtime_read_model" if required else "",
        "scope": "task_status_or_provenance" if required else "",
        "target": "explicit_or_recent_task" if required else "",
        "fallback": "ack_uncertainty" if required else "",
        "subject": "latest_execution_turn" if required else "",
        "fallback_to_control_tools": required,
    }


def latency_ack_policy(route: str, task_class: str, features: dict[str, Any]) -> dict[str, Any]:
    direct_state_lookup = bool(
        features.get("local_state_hits")
        or features.get("session_control_hits")
        or features.get("model_reference_hits")
        or features.get("runner_hits")
    )
    required = (
        route == "direct"
        and task_class != "control_observer"
        and bool(
            features.get("external_lookup_only")
            or features.get("bounded_repo_update_lookup")
            or features.get("fresh_live_lookup")
            or features.get("local_product_help_lookup")
            or (task_class == "session_control")
            or (task_class == "direct_answer" and direct_state_lookup)
        )
    )
    text = ""
    if required:
        if task_class == "session_control" or (task_class == "direct_answer" and direct_state_lookup):
            text = "我先看一下当前状态，马上回复你。"
        else:
            text = "我先看一下最新更新，马上给你结论。" if (features.get("bounded_repo_update_lookup") or features.get("fresh_live_lookup")) else ("我先查一下用法，马上给你结论。" if features.get("local_product_help_lookup") else "我先查一下，马上给你结论。")
    return {
        "required": required,
        "style": "brief_status",
        "channel_delivery_preferred": required,
        "text": text,
    }


def tool_policy(route: str, dispatch_required: bool, task_class: str = "") -> dict[str, Any]:
    block_patterns: list[str] = []
    if dispatch_required and route in ("spawn_single", "spawn_multi"):
        block_patterns.extend(["sessions_spawn", "subagents_send", "manual_subagent_spawn"])
    if route == "runner":
        block_patterns.extend(["manual_long_shell_loop"])
    observer_control_tools = [
        "octoclaw_policy_decide",
        "octoclaw_route_hint",
        "octoclaw_status",
        "octoclaw_task_action",
        "session_status",
    ]
    session_control_tools = [
        "octoclaw_policy_decide",
        "octoclaw_route_hint",
        "octoclaw_status",
        "session_status",
    ]
    return {
        "allow_direct_tools": route == "direct" and task_class not in {"control_observer", "session_control"},
        "must_delegate_via": "octoclaw_dispatch" if dispatch_required else "",
        "allowed_control_tools": [
            "octoclaw_policy_decide",
            "octoclaw_route_hint",
            "octoclaw_dispatch",
            "octoclaw_status",
            "octoclaw_task_action",
        ],
        "observer_control_tools": observer_control_tools,
        "session_control_tools": session_control_tools,
        "control_observer_only": task_class == "control_observer",
        "session_control_only": task_class == "session_control",
        "delegate_first": dispatch_required,
        "block_tool_patterns": block_patterns,
    }


def hook_interface(policy_cfg: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
    hooks_cfg = policy_cfg.get("hooks", {})
    policy_enabled = bool(policy_cfg.get("enabled", True))
    switch_cfg = policy_cfg.get("switches", {}) if isinstance(policy_cfg, dict) else {}
    route_decision = decision["route_decision"]
    model_policy = decision["model_policy"]
    skill_policy = decision["skill_policy"]
    review_policy = decision["review_policy"]
    route_hint_policy = decision["route_hint_policy"]
    state_grounding = decision.get("state_grounding", {}) if isinstance(decision.get("state_grounding", {}), dict) else {}

    return {
        "before_model_resolve": {
            "enabled": (
                policy_enabled
                and bool(hooks_cfg.get("before_model_resolve", True))
                and bool(switch_cfg.get("direct_model_override", True))
            ),
            "action": "override_model_selection",
            "selected_model": model_policy["selected_model"],
            "profile": model_policy["profile"],
            "reasoning_effort": model_policy["reasoning_effort"],
            "dispatch_required": route_decision["dispatch_required"],
        },
        "before_prompt_build": {
            "enabled": policy_enabled and bool(hooks_cfg.get("before_prompt_build", True)),
            "action": "inject_policy_context",
            "policy_context": {
                "route": route_decision["route"],
                "worker_pool": route_decision["worker_pool"],
                "work_type": route_decision["work_type"],
                "phase": route_decision["phase"],
                "protocol": route_decision["protocol"],
                "review_required": review_policy["required"],
                "route_hint_required": route_hint_policy["required"],
                "route_hint_submitted": route_hint_policy["submitted"],
            },
            "state_grounding": state_grounding,
            "skill_bundle": skill_policy["default_skill_bundle"],
            "prompt_contract": decision["prompt_contract"],
        },
        "before_tool_call": {
            "enabled": (
                policy_enabled
                and bool(hooks_cfg.get("before_tool_call", True))
                and (
                    route_decision["task_class"] == "control_observer"
                    or
                    route_hint_policy["required"]
                    or bool(switch_cfg.get("delegation_enforcement", True))
                )
            ),
            "action": "enforce_delegation_policy",
            "tool_policy": decision["tool_policy"],
            "delegation_enforcement": bool(switch_cfg.get("delegation_enforcement", True)),
            "route_hint_required": route_hint_policy["required"],
            "route_hint_submitted": route_hint_policy["submitted"],
            "route_hint_tool": "octoclaw_route_hint",
        },
        "agent_end": {
            "enabled": policy_enabled and bool(hooks_cfg.get("agent_end", True)),
            "action": "collect_summary_and_artifacts",
            "artifact_first": decision["prompt_contract"]["artifact_first"],
            "review_required": review_policy["required"],
            "final_compose_required": True,
            "route_hint_required": route_hint_policy["required"],
            "route_hint_submitted": route_hint_policy["submitted"],
        },
    }


def apply_forced_route(route_meta: dict[str, Any], forced_route: str) -> dict[str, Any]:
    if not forced_route:
        return route_meta
    payload = dict(route_meta)
    payload["system_preferred_route"] = forced_route
    payload["route"] = forced_route
    reasons = list(payload.get("reason_codes", []) or [])
    reasons.insert(0, f"forced_route:{forced_route}")
    payload["reason_codes"] = reasons
    payload["reasons"] = reasons
    payload["reason"] = reasons[0]
    payload["dispatch_required"] = forced_route != "direct"
    payload["main_agent_can_execute_directly"] = forced_route == "direct"
    payload["should_wait"] = forced_route == "runner"
    payload["execution_owner"] = {
        "direct": "main_agent",
        "runner": "persistent_runner",
        "spawn_single": "subagent",
        "spawn_multi": "subagent",
    }.get(forced_route, payload.get("execution_owner", "subagent"))
    return payload


def build_decision(
    task: str,
    command: str = "",
    metadata: dict[str, Any] | None = None,
    force_route: str = "",
    route_hint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = normalize_metadata(metadata)
    route_hint = normalize_route_hint(route_hint)
    route_meta = apply_forced_route(infer_route(task, command, metadata=metadata), force_route)
    features = route_meta.get("features", {})
    lane_feasibility = route_meta.get("lane_feasibility", {}) if isinstance(route_meta.get("lane_feasibility", {}), dict) else {}
    config = load_octopus_config()
    runtime_cfg = config.get("runtime_policy", {})
    _model_health_feedback_result = refresh_model_health_feedback_if_stale(
        feedback_cfg=(runtime_cfg.get("model_health_feedback", {}) if isinstance(runtime_cfg, dict) else {}),
    )
    base_route = str(route_meta.get("system_preferred_route", route_meta.get("route", "direct")) or "direct")
    correction_policy = route_hint_correction_policy(route_meta, force_route, runtime_cfg, lane_feasibility)
    sticky_state: dict[str, Any] = {}
    merge_reason_codes: list[str] = []
    route = base_route
    base_work_contract = str(route_meta.get("work_contract_hint", "") or "")
    route, sticky_state, sticky_reasons = apply_sticky_route(
        base_route,
        base_work_contract,
        features,
        route_hint,
        metadata,
        runtime_cfg,
        force_route,
        lane_feasibility,
    )
    merge_reason_codes.extend(sticky_reasons)
    if route_hint.get("route_hint"):
        route, hint_reasons = merge_route_from_hint(route, features, route_hint, lane_feasibility, correction_policy)
        merge_reason_codes.extend(hint_reasons)

    base_work_type = infer_work_type(task, features, route, metadata)
    work_type = merge_work_type(route, base_work_type, route_hint)
    base_phase = infer_phase(task, features, work_type, route, metadata)
    phase = merge_phase(route, base_phase, route_hint)
    work_contract = merge_work_contract(base_work_contract, route, sticky_state)
    executor_type = infer_executor_type(route)
    protocol = infer_protocol(features, route, work_type)
    worker_pool = infer_worker_pool(route, work_type)
    user_profile = infer_user_facing_profile(work_type, phase, route)
    model_band = infer_model_band(features, route, work_type, protocol)
    selector_band = selector_band_for_model_band(model_band, route=route)
    model_selector_role = model_role_for_worker_pool(
        worker_pool,
        phase=phase,
        route=route,
        profile=user_profile,
    )
    selected_model, model_thinking = resolve_model_and_thinking(
        selector_band,
        task,
        worker_pool=worker_pool,
        phase=phase,
        route=route,
        profile=user_profile,
    )

    profile = resolve_policy_profile(runtime_cfg, user_profile, selected_model)
    reasoning_effort = reasoning_effort_from_config(runtime_cfg, model_band, profile, model_thinking)
    needs_review = review_required(features, route, work_type, protocol)
    if route_hint.get("review_required"):
        needs_review = True
    default_skill_bundle = resolve_skill_bundle(runtime_cfg, work_type, profile)
    base_reason_codes = list(route_meta.get("reason_codes", []) or [])
    merged_reason_codes = [*merge_reason_codes, *base_reason_codes]
    route_hint_policy = build_route_hint_policy(route_meta, base_route, route, base_reason_codes, route_hint, force_route, runtime_cfg, sticky_state)
    route_hint_policy["ack_followup_candidate"] = bool(features.get("ack_followup_candidate")) or bool(route_hint_policy.get("ack_followup_candidate"))
    if bool((sticky_state or {}).get("applied")) and route in {"spawn_single", "spawn_multi"}:
        route_hint_policy["required"] = False
        merge_reason_codes.append("route_hint_suppressed:sticky_lane")
    elif bool(route_hint_policy.get("ack_followup_applied")) and route in {"spawn_single", "spawn_multi"}:
        route_hint_policy["required"] = False
        merge_reason_codes.append("route_hint_suppressed:ack_followup")
    route_hint_policy["merge_notes"] = merge_reason_codes
    route_hint_policy = finalize_route_hint_policy(route_hint_policy, merge_reason_codes, route)
    dispatch_required = route != "direct"
    should_wait = route == "runner"
    wait_timeout_seconds = int(route_meta.get("wait_timeout_seconds", 0) or 0) if should_wait else 0
    task_class = str(route_meta.get("task_class", "") or "")
    route_budget = budget_policy(features, route, work_contract, protocol, needs_review)
    prompt_policy = prompt_contract(protocol, route, work_contract, needs_review)
    pre_dispatch_ack = pre_dispatch_ack_policy(route, work_type, phase, task_class, features)
    state_grounding = state_grounding_policy(route_meta, route, task_class)
    latency_ack = latency_ack_policy(route, task_class, features)
    route_recommendation = build_route_recommendation(
        route_meta,
        {
            "route": route,
            "worker_pool": worker_pool,
            "work_type": work_type,
            "phase": phase,
            "model_band": model_band,
        },
    )
    budget_recommendation = build_budget_recommendation_payload(
        budget_policy=route_budget,
        model_policy={
            "selected_model": selected_model,
            "fallbacks": [],
            "reasoning_effort": reasoning_effort,
        },
        route=route,
    )

    decision = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": utc_now(),
        "features": features,
        "route_language_packs": list(route_meta.get("route_language_packs", []) or []),
        "request": {
            "task": task,
            "command": command,
            "channel": normalize_channel(str(metadata.get("channel", "") or "")),
            "session_key": str(metadata.get("session_key", "") or ""),
            "metadata": metadata,
        },
        "route_decision": {
            "system_preferred_route": base_route,
            "route": route,
            "work_contract": work_contract,
            "work_contract_hint": str(route_meta.get("work_contract_hint", "") or ""),
            "contract_kind": str(route_meta.get("contract_kind", "") or ""),
            "scope_hint": str(route_meta.get("scope_hint", "") or ""),
            "capability_requirements": list(route_meta.get("capability_requirements", []) or []),
            "lane_feasibility": lane_feasibility,
            "feasible_lanes": list(route_meta.get("feasible_lanes", []) or []),
            "protected_lane": str(route_meta.get("protected_lane", "") or ""),
            "dispatch_required": dispatch_required,
            "confidence": route_meta.get("confidence", 0.0),
            "reason": merged_reason_codes[0] if merged_reason_codes else route_meta.get("reason", ""),
            "reason_codes": merged_reason_codes,
            "scores": route_meta.get("scores", {}),
            "task_class": route_meta.get("task_class", ""),
            "executor_type": executor_type,
            "worker_pool": worker_pool,
            "work_type": work_type,
            "phase": phase,
            "protocol": protocol,
            "should_wait": should_wait,
            "wait_timeout_seconds": wait_timeout_seconds,
            "expected_latency_ms": int(route_meta.get("expected_latency_ms", 0) or 0),
            "expected_cost_band": str(route_meta.get("expected_cost_band", "") or ""),
            "context_growth_band": str(route_meta.get("context_growth_band", "") or ""),
            "parallel_gain_band": str(route_meta.get("parallel_gain_band", "") or ""),
            "artifact_required": bool(route_meta.get("needs_artifact", False)),
            "durable_runtime_required": bool(route_meta.get("needs_durable_runtime", False)),
            "runner_materialization_available": bool(route_meta.get("runner_materialization_available", False)),
            "runner_materialization_kind": str(route_meta.get("runner_materialization_kind", "") or ""),
            "runner_playbook": (
                dict(route_meta.get("runner_playbook", {}))
                if route == "runner" and isinstance(route_meta.get("runner_playbook", {}), dict)
                else {}
            ),
        },
        "budget_policy": route_budget,
        "model_policy": {
            "worker_pool": worker_pool,
            "model_selector_role": model_selector_role,
            "selector_band": selector_band,
            "model_band": model_band,
            "selected_model": selected_model,
            "profile": profile,
            "reasoning_effort": reasoning_effort,
            "fallbacks": [],
        },
        "skill_policy": {
            "default_skill_bundle": default_skill_bundle,
            "dynamic_discovery_allowed": True,
        },
        "review_policy": {
            "required": needs_review,
            "review_worker_pool": "octoclaw-review" if needs_review else "",
            "review_trigger": "policy_required" if needs_review else "",
        },
        "route_recommendation": route_recommendation,
        "budget_recommendation": budget_recommendation,
        "prompt_contract": prompt_policy,
        "pre_dispatch_ack": pre_dispatch_ack,
        "state_grounding": state_grounding,
        "latency_ack": latency_ack,
        "tool_policy": tool_policy(route, dispatch_required, task_class),
        "route_hint_policy": route_hint_policy,
        "runtime_switches": runtime_switches_summary(runtime_cfg),
    }
    decision["summary"] = summarize_decision(decision)
    decision["auto_router"] = build_auto_router_payload(decision)
    decision["hook_interface"] = hook_interface(runtime_cfg, decision)
    return decision


def summarize_decision(decision: dict[str, Any]) -> str:
    route_decision = decision.get("route_decision", {})
    model_policy = decision.get("model_policy", {})
    route = route_decision.get("route", "direct")
    worker_pool = route_decision.get("worker_pool", "octoclaw-main")
    work_type = route_decision.get("work_type", "")
    phase = route_decision.get("phase", "")
    profile = model_policy.get("profile", "")
    model_band = model_policy.get("model_band", "")
    model = model_policy.get("selected_model", "")
    if model:
        return f"policy={route} -> {worker_pool} / {work_type}:{phase} / {model_band} / profile={profile} / model={model}"
    return f"policy={route} -> {worker_pool} / {work_type}:{phase} / {model_band} / profile={profile}"


_build_decision_legacy = build_decision


def _build_decision_via_node(
    task: str,
    command: str = "",
    metadata: dict[str, Any] | None = None,
    force_route: str = "",
    route_hint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compatibility shim: Node runtime is the source of truth for policy decisions."""
    import os
    import subprocess
    from pathlib import Path

    config = load_octopus_config()
    runtime_cfg = config.get("runtime_policy", {}) if isinstance(config, dict) else {}
    refresh_model_health_feedback_if_stale(
        feedback_cfg=(runtime_cfg.get("model_health_feedback", {}) if isinstance(runtime_cfg, dict) else {}),
    )

    repo_root = Path(__file__).resolve().parents[1]
    extension_path = repo_root / "extensions" / "octoclaw-runtime" / "index.js"
    from node_runtime import ensure_node_environment, resolve_node_bin
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(extension_path))};
const task = {json.dumps(task or "", ensure_ascii=False)};
const options = {{
  command: {json.dumps(command or "", ensure_ascii=False)},
  metadata: {json.dumps(metadata or {}, ensure_ascii=False)},
  forceRoute: {json.dumps(force_route or "", ensure_ascii=False)},
  routeHint: {json.dumps(route_hint or {}, ensure_ascii=False)}
}};
const value = await __octoclawTest.resolveStatelessPolicyDecision(task, options);
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        [resolve_node_bin(), "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(repo_root),
        env=ensure_node_environment(),
        check=True,
    )
    return json.loads(result.stdout)


def build_decision(
    task: str,
    command: str = "",
    metadata: dict[str, Any] | None = None,
    force_route: str = "",
    route_hint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _build_decision_via_node(task, command, metadata, force_route, route_hint)


def main() -> None:
    parser = argparse.ArgumentParser(description="OctoClaw runtime policy decision entry")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    parser.add_argument("--channel", default="")
    parser.add_argument("--session-key", default="")
    parser.add_argument("--metadata-json", default="")
    parser.add_argument("--force-route", choices=sorted(VALID_FORCE_ROUTES - {""}), default="")
    parser.add_argument("--route-hint-json", default="")
    parser.add_argument("--summary", action="store_true", help="Print a one-line summary instead of JSON")
    args = parser.parse_args()

    metadata: dict[str, Any] = {}
    if args.metadata_json:
        try:
            parsed = json.loads(args.metadata_json)
            if isinstance(parsed, dict):
                metadata.update(parsed)
        except json.JSONDecodeError:
            pass
    if args.channel:
        metadata["channel"] = args.channel
    if args.session_key:
        metadata["session_key"] = args.session_key

    route_hint: dict[str, Any] = {}
    if args.route_hint_json:
        try:
            parsed = json.loads(args.route_hint_json)
            if isinstance(parsed, dict):
                route_hint = parsed
        except json.JSONDecodeError:
            pass

    decision = build_decision(args.task, args.command, metadata, args.force_route, route_hint)
    if args.summary:
        print(summarize_decision(decision))
        return
    print(json.dumps(decision, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
