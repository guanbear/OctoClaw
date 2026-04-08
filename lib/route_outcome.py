#!/usr/bin/env python3
"""Route outcome contract helpers."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "octoclaw.route_outcome/v1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def build_route_outcome(
    *,
    decision: dict[str, Any] | None,
    event_type: str,
    payload: dict[str, Any] | None = None,
    runtime_resolution: dict[str, Any] | None = None,
) -> dict[str, Any]:
    decision = decision if isinstance(decision, dict) else {}
    payload = payload if isinstance(payload, dict) else {}
    runtime_resolution = runtime_resolution if isinstance(runtime_resolution, dict) else {}
    route_decision = decision.get("route_decision", {}) if isinstance(decision.get("route_decision"), dict) else {}
    route_recommendation = decision.get("route_recommendation", {}) if isinstance(decision.get("route_recommendation"), dict) else {}
    budget_recommendation = decision.get("budget_recommendation", {}) if isinstance(decision.get("budget_recommendation"), dict) else {}
    auto_router = decision.get("auto_router", {}) if isinstance(decision.get("auto_router"), dict) else {}
    router_core = auto_router.get("router_core", {}) if isinstance(auto_router.get("router_core"), dict) else {}
    model_intel = auto_router.get("model_intel", {}) if isinstance(auto_router.get("model_intel"), dict) else {}
    request = decision.get("request", {}) if isinstance(decision.get("request"), dict) else {}

    recommended_route = _text(route_recommendation.get("recommended_route")) or _text(route_decision.get("route")) or "direct"
    resolved_route = (
        _text(payload.get("finalRoute"))
        or _text(payload.get("route"))
        or _text(runtime_resolution.get("resolved_route"))
        or recommended_route
    )
    recommended_model = (
        _text(model_intel.get("selected_model"))
        or _text(budget_recommendation.get("target_model"))
        or _text(payload.get("recommendedModel"))
    )
    resolved_model = (
        _text(payload.get("resolvedModel"))
        or _text(payload.get("model"))
        or _text(runtime_resolution.get("resolved_model"))
        or recommended_model
    )
    fallback_taken = bool(
        payload.get("fallbackTaken")
        or payload.get("fallback_taken")
        or runtime_resolution.get("fallback_taken")
        or (recommended_model and resolved_model and recommended_model != resolved_model)
        or (recommended_route and resolved_route and recommended_route != resolved_route)
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "event_type": _text(event_type),
        "execution_contract": recommended_route,
        "resolved_execution_contract": resolved_route,
        "agent_scope": _text(router_core.get("agent_scope")),
        "route_class": _text(router_core.get("route_class")),
        "worker_pool": _text(route_decision.get("worker_pool")),
        "phase": _text(route_decision.get("phase")),
        "protocol": _text(route_decision.get("protocol")),
        "profile": _text(decision.get("model_policy", {}).get("profile") if isinstance(decision.get("model_policy"), dict) else ""),
        "skill_bundle": list((decision.get("skill_policy", {}) or {}).get("default_skill_bundle", []) or [])
        if isinstance(decision.get("skill_policy"), dict)
        else [],
        "recommended_model": recommended_model,
        "resolved_model": resolved_model,
        "output_budget": _text(budget_recommendation.get("output_budget")),
        "reasoning_mode": _text(budget_recommendation.get("reasoning_mode")),
        "review_required": bool((decision.get("review_policy", {}) or {}).get("required")) if isinstance(decision.get("review_policy"), dict) else False,
        "artifact_first": bool((decision.get("prompt_contract", {}) or {}).get("artifact_first")) if isinstance(decision.get("prompt_contract"), dict) else False,
        "handoff_contract": _text((decision.get("prompt_contract", {}) or {}).get("handoff_contract")) if isinstance(decision.get("prompt_contract"), dict) else "",
        "reason_codes": list(route_decision.get("reason_codes", []) or []),
        "route_source": _text(payload.get("routeSource") or payload.get("route_source") or runtime_resolution.get("route_source") or "rule"),
        "sticky_applied": bool(payload.get("stickyApplied") if "stickyApplied" in payload else decision.get("route_hint_policy", {}).get("sticky_applied"))
        if isinstance(decision.get("route_hint_policy"), dict)
        else bool(payload.get("stickyApplied")),
        "ack_followup_applied": bool(payload.get("ackFollowupApplied") if "ackFollowupApplied" in payload else decision.get("route_hint_policy", {}).get("ack_followup_applied"))
        if isinstance(decision.get("route_hint_policy"), dict)
        else bool(payload.get("ackFollowupApplied")),
        "channel": _text(request.get("channel")),
        "route_language_packs": list(decision.get("route_language_packs", []) or []),
        "fallback_taken": fallback_taken,
        "runner_health_snapshot": runtime_resolution.get("runner_health_snapshot", {}),
        "queue_pressure_band": _text(runtime_resolution.get("queue_pressure_band")),
        "quota_pressure_band": _text(runtime_resolution.get("quota_pressure_band")),
        "actual_cost": payload.get("actualCost", payload.get("actual_cost")) if payload.get("actualCost", payload.get("actual_cost")) is not None else None,
        "actual_latency": payload.get("actualLatency", payload.get("actual_latency")) if payload.get("actualLatency", payload.get("actual_latency")) is not None else None,
        "validation_outcome": _text(payload.get("validationOutcome") or payload.get("validation_outcome")),
    }
