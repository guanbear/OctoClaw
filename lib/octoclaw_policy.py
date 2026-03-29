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

from octoclaw_route import infer_route
from octoclaw_spawn import resolve_model_and_thinking
from octopus_config import ROUTE_STICKINESS_FILE, load_json, load_octopus_config
from runtime_protocol import BRIEF_SCHEMA_VERSION, WORKER_RESULT_SCHEMA_VERSION
from worker_taxonomy import (
    infer_worker_pool as taxonomy_infer_worker_pool,
    legacy_label_for_worker_pool,
    model_role_for_worker_pool,
)


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
    return True


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
    if route not in ("spawn_single", "spawn_multi"):
        return {}
    return entry


def apply_sticky_route(
    base_route: str,
    features: dict[str, Any],
    route_hint: dict[str, Any],
    metadata: dict[str, Any],
    policy_cfg: dict[str, Any],
    forced_route: str,
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
    if base_route == "runner":
        return base_route, {}, []

    sticky_route = str(sticky.get("route", "") or "").strip()
    if sticky_route not in ("spawn_single", "spawn_multi"):
        return base_route, {}, []
    sticky_state = {
        "route": sticky_route,
        "applied": True,
        "ack_followup_candidate": ack_followup_candidate,
        "ack_followup_applied": ack_followup_candidate,
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


def merge_route_from_hint(base_route: str, features: dict[str, Any], route_hint: dict[str, Any]) -> tuple[str, list[str]]:
    hint_route = str(route_hint.get("route_hint", "") or "").strip()
    if not hint_route:
        return base_route, []

    reason_codes = [f"main_agent_route_hint:{hint_route}"]
    if hint_route == "direct":
        if direct_allowed_from_hint(features):
            return "direct", reason_codes
        fallback = "spawn_multi" if features.get("parallelizable") else "spawn_single"
        reason_codes.append(f"route_hint_veto:direct_to_{fallback}")
        return fallback, reason_codes

    if hint_route == "spawn_multi":
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


def build_route_hint_policy(
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
    required = route_hint_required({"reason_codes": base_reason_codes}, forced_route, policy_cfg)
    source = "system_preferred"
    if submitted:
        source = "main_agent"
    elif forced_route:
        source = "forced_route"
    elif bool((sticky_state or {}).get("applied")):
        source = "sticky_lane"
    return {
        "required": required,
        "hard_gate_applied": hard_gate_applied,
        "hard_gate_reason": "hard_runner_only" if hard_gate_applied else "",
        "submitted": submitted,
        "source": source,
        "accepted_routes": ["direct", "spawn_single", "spawn_multi"],
        "system_preferred_route": base_route,
        "final_route": final_route,
        "hint_route": str(route_hint.get("route_hint", "") or ""),
        "hint_work_type": str(route_hint.get("work_type", "") or ""),
        "hint_phase": str(route_hint.get("phase", "") or ""),
        "hint_review_required": bool(route_hint.get("review_required", False)),
        "hint_confidence": float(route_hint.get("confidence", 0.0) or 0.0),
        "hint_reason": str(route_hint.get("reason", "") or ""),
        "merge_notes": [],
        "sticky_applied": bool((sticky_state or {}).get("applied")),
        "sticky_route": str((sticky_state or {}).get("route", "") or ""),
        "sticky_work_type": str((sticky_state or {}).get("work_type", "") or ""),
        "ack_followup_candidate": bool((sticky_state or {}).get("ack_followup_candidate")),
        "ack_followup_applied": bool((sticky_state or {}).get("ack_followup_applied")),
    }


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


def infer_legacy_label(work_type: str, phase: str, route: str, profile: str = "") -> str:
    return legacy_label_for_worker_pool(
        infer_worker_pool(route, work_type),
        phase=phase,
        route=route,
        profile=profile,
    )


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


def selector_tier_for_model_band(model_band: str, route: str) -> str:
    if route == "runner":
        return "trivial"
    return {
        "fast": "simple",
        "normal": "normal",
        "strong": "hard",
        "heavy": "deep",
    }.get(model_band, "normal")


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
    by_tier = cfg.get("default_reasoning_effort_by_tier", {})
    if isinstance(by_tier, dict):
        value = str(by_tier.get(model_band, "") or "").strip()
        if value:
            return value
    legacy_fallbacks = {
        "fast": "simple",
        "normal": "normal",
        "strong": "hard",
        "heavy": "deep",
    }
    by_legacy_tier = cfg.get("default_reasoning_effort_by_legacy_tier", {})
    if isinstance(by_legacy_tier, dict):
        value = str(by_legacy_tier.get(legacy_fallbacks.get(model_band, "normal"), "") or "").strip()
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


def prompt_contract(protocol: str, route: str) -> dict[str, Any]:
    return {
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
    }


def tool_policy(route: str, dispatch_required: bool) -> dict[str, Any]:
    block_patterns: list[str] = []
    if dispatch_required and route in ("spawn_single", "spawn_multi"):
        block_patterns.extend(["sessions_spawn", "subagents_send", "manual_subagent_spawn"])
    if route == "runner":
        block_patterns.extend(["manual_long_shell_loop"])
    return {
        "allow_direct_tools": route == "direct",
        "must_delegate_via": "octoclaw_dispatch" if dispatch_required else "",
        "allowed_control_tools": [
            "octoclaw_policy_decide",
            "octoclaw_route_hint",
            "octoclaw_dispatch",
            "octoclaw_status",
        ],
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
            "skill_bundle": skill_policy["default_skill_bundle"],
            "prompt_contract": decision["prompt_contract"],
        },
        "before_tool_call": {
            "enabled": (
                policy_enabled
                and bool(hooks_cfg.get("before_tool_call", True))
                and bool(switch_cfg.get("delegation_enforcement", True))
            ),
            "action": "enforce_delegation_policy",
            "tool_policy": decision["tool_policy"],
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
    route_meta = apply_forced_route(infer_route(task, command), force_route)
    features = route_meta.get("features", {})
    runtime_cfg = load_octopus_config().get("runtime_policy", {})
    base_route = str(route_meta.get("system_preferred_route", route_meta.get("route", "direct")) or "direct")
    sticky_state: dict[str, Any] = {}
    merge_reason_codes: list[str] = []
    route = base_route
    if route_hint_required(route_meta, force_route, runtime_cfg):
        route, sticky_state, sticky_reasons = apply_sticky_route(
            base_route,
            features,
            route_hint,
            metadata,
            runtime_cfg,
            force_route,
        )
        merge_reason_codes.extend(sticky_reasons)
        if route_hint.get("route_hint"):
            route, hint_reasons = merge_route_from_hint(route, features, route_hint)
            merge_reason_codes.extend(hint_reasons)

    base_work_type = infer_work_type(task, features, route, metadata)
    work_type = merge_work_type(route, base_work_type, route_hint)
    base_phase = infer_phase(task, features, work_type, route, metadata)
    phase = merge_phase(route, base_phase, route_hint)
    executor_type = infer_executor_type(route)
    protocol = infer_protocol(features, route, work_type)
    worker_pool = infer_worker_pool(route, work_type)
    user_profile = infer_user_facing_profile(work_type, phase, route)
    model_band = infer_model_band(features, route, work_type, protocol)
    selector_tier = selector_tier_for_model_band(model_band, route)
    legacy_tier = selector_tier
    legacy_label = infer_legacy_label(work_type, phase, route, user_profile)
    model_selector_role = model_role_for_worker_pool(
        worker_pool,
        phase=phase,
        route=route,
        profile=user_profile,
    )
    selected_model, model_thinking = resolve_model_and_thinking(
        selector_tier,
        "",
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
    route_hint_policy = build_route_hint_policy(base_route, route, base_reason_codes, route_hint, force_route, runtime_cfg, sticky_state)
    route_hint_policy["ack_followup_candidate"] = bool(features.get("ack_followup_candidate")) or bool(route_hint_policy.get("ack_followup_candidate"))
    route_hint_policy["merge_notes"] = merge_reason_codes
    dispatch_required = route != "direct"
    should_wait = route == "runner"
    wait_timeout_seconds = int(route_meta.get("wait_timeout_seconds", 0) or 0) if should_wait else 0

    decision = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": utc_now(),
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
        },
        "model_policy": {
            "legacy_label": legacy_label,
            "legacy_tier": legacy_tier,
            "worker_pool": worker_pool,
            "model_selector_role": model_selector_role,
            "selector_tier": selector_tier,
            "tier": model_band,
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
        "prompt_contract": prompt_contract(protocol, route),
        "tool_policy": tool_policy(route, dispatch_required),
        "route_hint_policy": route_hint_policy,
        "runtime_switches": runtime_switches_summary(runtime_cfg),
        "compat": {
            "legacy_role_hint": str(route_meta.get("role_hint", "") or ""),
            "legacy_tier_hint": legacy_tier,
        },
    }
    decision["summary"] = summarize_decision(decision)
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
    tier = model_policy.get("tier", "")
    model = model_policy.get("selected_model", "")
    if model:
        return f"policy={route} -> {worker_pool} / {work_type}:{phase} / {tier} / profile={profile} / model={model}"
    return f"policy={route} -> {worker_pool} / {work_type}:{phase} / {tier} / profile={profile}"


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
