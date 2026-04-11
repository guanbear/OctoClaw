#!/usr/bin/env python3
"""Internal-first Auto Router contracts for OctoClaw."""

from __future__ import annotations

import argparse
import json
from typing import Any

try:
    from octopus_config import (
        MODEL_BENCHMARKS_FILE,
        MODEL_CATALOG_FILE,
        MODEL_HEALTH_FILE,
        MODEL_INTEL_SOURCE_STATUS_FILE,
        MODEL_PLAN_STATE_FILE,
        MODEL_POLICY_FILE,
        MODEL_SOURCES_FILE,
        MODEL_SPEED_FILE,
    )
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import (
        MODEL_BENCHMARKS_FILE,
        MODEL_CATALOG_FILE,
        MODEL_HEALTH_FILE,
        MODEL_INTEL_SOURCE_STATUS_FILE,
        MODEL_PLAN_STATE_FILE,
        MODEL_POLICY_FILE,
        MODEL_SOURCES_FILE,
        MODEL_SPEED_FILE,
    )


SIGNAL_SCHEMA_VERSION = "octoclaw.auto_router.signal/v1"
ROUTER_CORE_SCHEMA_VERSION = "octoclaw.auto_router.router_core/v1"
BUDGET_PLANNER_SCHEMA_VERSION = "octoclaw.auto_router.budget_planner/v1"
MODEL_INTEL_SCHEMA_VERSION = "octoclaw.auto_router.model_intel/v1"
ADAPTER_SCHEMA_VERSION = "octoclaw.auto_router.adapter/v1"
RECOMMENDATION_SCHEMA_VERSION = "octoclaw.auto_router.recommendation/v1"
BUDGET_RECOMMENDATION_SCHEMA_VERSION = "octoclaw.budget_recommendation/v1"
DEFAULT_MODEL_INTEL_PRECEDENCE = {
    "identity": ["operator_override", "curated_local_catalog", "external_model_registry"],
    "capabilities": ["operator_override", "external_model_registry", "curated_local_catalog", "built_in_defaults"],
    "pricing": ["operator_override", "external_model_registry", "secondary_sync_source", "built_in_defaults"],
    "runtime": ["provider_runtime_observation", "operator_override", "built_in_defaults"],
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def infer_route_class(*, route: str, protected_lane: str, task_class: str) -> str:
    if protected_lane == "control_observer" or task_class == "control_observer":
        return "control_observer"
    if protected_lane == "session_control" or task_class == "session_control":
        return "session_control"
    if route == "direct":
        return "main_direct"
    if route == "runner":
        return "delegated_runner"
    if route == "spawn_multi":
        return "delegated_multi"
    if route == "spawn_single":
        return "delegated_single"
    return "unknown"


def infer_agent_scope(executor_type: str) -> str:
    if executor_type == "main":
        return "main_agent"
    if executor_type == "runner":
        return "runner_lane"
    if executor_type == "team":
        return "team_lane"
    if executor_type == "subagent":
        return "subagent_lane"
    return "unknown"


def infer_policy_phase(runtime_switches: dict[str, Any] | None) -> str:
    switches = dict(runtime_switches or {})
    if bool(switches.get("route_hint_required_enabled")) or bool(switches.get("direct_model_override_enabled")):
        return "enforced"
    if bool(switches.get("delegation_enforcement_enabled")) or bool(switches.get("sticky_lane_enabled")):
        return "guided"
    return "conservative"


def build_signal_payload(
    *,
    task: str,
    command: str,
    metadata: dict[str, Any],
    route_meta: dict[str, Any],
    route_hint: dict[str, Any],
    route_decision: dict[str, Any],
    runtime_switches: dict[str, Any],
    feedback_signals: dict[str, Any] | None = None,
) -> dict[str, Any]:
    features = dict(route_meta.get("features", {})) if isinstance(route_meta.get("features"), dict) else {}
    return {
        "schema_version": SIGNAL_SCHEMA_VERSION,
        "request": {
            "task": task,
            "command": command,
            "metadata": dict(metadata),
            "session_key": _text(metadata.get("session_key")),
            "session_origin": _text(metadata.get("channel")),
        },
        "contract": {
            "work_contract_hint": _text(route_meta.get("work_contract_hint")),
            "artifact_need": bool(route_meta.get("needs_artifact", False)),
            "durable_runtime_need": bool(route_meta.get("needs_durable_runtime", False)),
            "parallel_gain": _text(route_meta.get("parallel_gain_band")),
            "risk_level": "high" if bool(features.get("high_risk")) else ("medium" if bool(route_decision.get("review_required")) else "low"),
        },
        "continuity": {
            "route_hint": _text(route_hint.get("route_hint")),
            "sticky_lane": _text(route_decision.get("sticky_lane")),
            "followup_kind": "ack" if bool(route_decision.get("ack_followup_candidate")) else "",
            "session_resume": metadata.get("resume_context", {}) if isinstance(metadata.get("resume_context"), dict) else {},
        },
        "model_signals": {
            "model_band_hint": _text(route_meta.get("model_band_hint")),
            "semantic_model_hint": _text(route_meta.get("semantic_model_hint")),
            "expected_cost_band": _text(route_meta.get("expected_cost_band")),
            "expected_latency_ms": int(route_meta.get("expected_latency_ms", 0) or 0),
        },
        "feedback_signals": {
            "policy_phase": infer_policy_phase(runtime_switches),
            "replay_logging_enabled": bool(runtime_switches.get("replay_logging_enabled")),
            "promotion_eligibility": _text((feedback_signals or {}).get("promotion_eligibility")),
            "validation_status": _text((feedback_signals or {}).get("validation_status")),
            "learning_flags": list((feedback_signals or {}).get("learning_flags") or []),
        },
    }


def build_router_core_payload(
    *,
    route_meta: dict[str, Any],
    route_decision: dict[str, Any],
    review_required: bool,
) -> dict[str, Any]:
    executor_type = _text(route_decision.get("executor_type"))
    route = _text(route_decision.get("route"))
    return {
        "schema_version": ROUTER_CORE_SCHEMA_VERSION,
        "route": route,
        "route_class": infer_route_class(
            route=route,
            protected_lane=_text(route_decision.get("protected_lane")),
            task_class=_text(route_decision.get("task_class")),
        ),
        "agent_scope": infer_agent_scope(executor_type),
        "work_contract": _text(route_decision.get("work_contract")),
        "executor_type": executor_type,
        "confidence": route_meta.get("confidence", 0.0),
        "reason_codes": list(route_decision.get("reason_codes") or route_meta.get("reason_codes") or []),
        "required_evidence": ["validation"] if review_required else ["replay"],
        "review_required": bool(review_required),
        "next_evaluation_target": "validation" if review_required else "replay",
    }


def build_budget_planner_payload(
    *,
    budget_policy: dict[str, Any],
    model_policy: dict[str, Any],
    route: str,
) -> dict[str, Any]:
    fallbacks = list(model_policy.get("fallbacks") or [])
    output_budget = _text(budget_policy.get("budget_cap"))
    latency_target = _text(budget_policy.get("latency_target"))
    max_workers = int(budget_policy.get("max_workers", 0) or 0)
    retry_budget = int(budget_policy.get("retry_cap", 0) or 0)
    consistency = build_budget_consistency_payload(
        route=route,
        output_budget=output_budget,
        latency_target=latency_target,
        max_workers=max_workers,
        retry_budget=retry_budget,
    )
    return {
        "schema_version": BUDGET_PLANNER_SCHEMA_VERSION,
        "target_model": _text(model_policy.get("selected_model")),
        "fallback_model": _text(fallbacks[0] if fallbacks else ""),
        "output_budget": output_budget,
        "retry_budget": retry_budget,
        "latency_target": latency_target,
        "max_workers": max_workers,
        "reasoning_mode": _text(model_policy.get("reasoning_effort")),
        "upgrade_allowed": bool(budget_policy.get("upgrade_allowed")),
        "cost_ceiling": output_budget,
        "consistency": consistency,
    }


def build_budget_recommendation_payload(
    *,
    budget_policy: dict[str, Any],
    model_policy: dict[str, Any],
    route: str,
) -> dict[str, Any]:
    payload = build_budget_planner_payload(
        budget_policy=budget_policy,
        model_policy=model_policy,
        route=route,
    )
    payload["schema_version"] = BUDGET_RECOMMENDATION_SCHEMA_VERSION
    return payload


def build_budget_consistency_payload(
    *,
    route: str,
    output_budget: str,
    latency_target: str,
    max_workers: int,
    retry_budget: int,
) -> dict[str, Any]:
    route_name = _text(route)
    output_ok = False
    latency_ok = False
    workers_ok = False
    retry_ok = retry_budget >= 0

    if route_name == "direct":
        output_ok = output_budget == "tiny"
        latency_ok = latency_target == "interactive"
        workers_ok = max_workers == 0
    elif route_name == "runner":
        output_ok = output_budget in {"tiny", "low"}
        latency_ok = latency_target == "interactive"
        workers_ok = max_workers == 1
    elif route_name == "spawn_single":
        output_ok = output_budget in {"low", "medium"}
        latency_ok = latency_target == "background"
        workers_ok = max_workers == 1
    elif route_name == "spawn_multi":
        output_ok = output_budget in {"medium", "high"}
        latency_ok = latency_target == "background"
        workers_ok = max_workers >= 2
    else:
        output_ok = bool(output_budget)
        latency_ok = bool(latency_target)
        workers_ok = max_workers >= 0

    return {
        "route": route_name,
        "route_matches_output_budget": bool(output_ok),
        "route_matches_latency_target": bool(latency_ok),
        "route_matches_worker_budget": bool(workers_ok),
        "retry_budget_valid": bool(retry_ok),
        "route_budget_consistent": bool(output_ok and latency_ok and workers_ok and retry_ok),
    }


def build_model_intel_payload(*, model_policy: dict[str, Any]) -> dict[str, Any]:
    selected_model = _text(model_policy.get("selected_model"))
    provider = selected_model.split("/")[0] if "/" in selected_model else ""
    facts_plane = model_policy.get("facts_plane") if isinstance(model_policy.get("facts_plane"), dict) else {}
    fallbacks = [
        _text(item)
        for item in list(model_policy.get("fallbacks") or [])
        if _text(item)
    ]
    candidate_models = []
    if selected_model:
        candidate_models.append(selected_model)
    for fallback in fallbacks:
        if fallback not in candidate_models:
            candidate_models.append(fallback)
    return {
        "schema_version": MODEL_INTEL_SCHEMA_VERSION,
        "selected_model": selected_model,
        "candidate_models": candidate_models,
        "provider": provider,
        "model_band": _text(model_policy.get("model_band")),
        "selector_band": _text(model_policy.get("selector_band")),
        "selector_role": _text(model_policy.get("model_selector_role")),
        "facts_plane": facts_plane
        or {
            "source_status_file": MODEL_INTEL_SOURCE_STATUS_FILE,
            "source_precedence": DEFAULT_MODEL_INTEL_PRECEDENCE,
        },
        "source_files": {
            "catalog": MODEL_CATALOG_FILE,
            "policy": MODEL_POLICY_FILE,
            "health": MODEL_HEALTH_FILE,
            "speed": MODEL_SPEED_FILE,
            "plan_state": MODEL_PLAN_STATE_FILE,
            "benchmarks": MODEL_BENCHMARKS_FILE,
            "sources": MODEL_SOURCES_FILE,
            "source_status": MODEL_INTEL_SOURCE_STATUS_FILE,
        },
    }


def build_adapter_payload(
    *,
    prompt_contract: dict[str, Any],
    tool_policy: dict[str, Any],
    route_hint_policy: dict[str, Any],
    runtime_switches: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": ADAPTER_SCHEMA_VERSION,
        "policy_phase": infer_policy_phase(runtime_switches),
        "merge_contract": _text(prompt_contract.get("merge_contract")),
        "handoff_contract": _text(prompt_contract.get("handoff_contract")),
        "route_hint_required": bool(route_hint_policy.get("required")),
        "dispatch_required": bool(tool_policy.get("dispatch_required")),
        "control_observer_only": bool(tool_policy.get("control_observer_only")),
    }


def build_auto_router_payload(decision: dict[str, Any]) -> dict[str, Any]:
    request = decision.get("request", {}) if isinstance(decision.get("request"), dict) else {}
    route_decision = decision.get("route_decision", {}) if isinstance(decision.get("route_decision"), dict) else {}
    model_policy = decision.get("model_policy", {}) if isinstance(decision.get("model_policy"), dict) else {}
    budget_policy = decision.get("budget_policy", {}) if isinstance(decision.get("budget_policy"), dict) else {}
    route_hint_policy = decision.get("route_hint_policy", {}) if isinstance(decision.get("route_hint_policy"), dict) else {}
    prompt_contract = decision.get("prompt_contract", {}) if isinstance(decision.get("prompt_contract"), dict) else {}
    tool_policy = decision.get("tool_policy", {}) if isinstance(decision.get("tool_policy"), dict) else {}
    runtime_switches = decision.get("runtime_switches", {}) if isinstance(decision.get("runtime_switches"), dict) else {}

    route_meta = {
        "features": decision.get("features", {}),
        "confidence": route_decision.get("confidence", 0.0),
        "reason_codes": route_decision.get("reason_codes", []),
        "work_contract_hint": route_decision.get("work_contract_hint", ""),
        "needs_artifact": route_decision.get("artifact_required", False),
        "needs_durable_runtime": route_decision.get("durable_runtime_required", False),
        "parallel_gain_band": route_decision.get("parallel_gain_band", ""),
        "expected_cost_band": route_decision.get("expected_cost_band", ""),
        "expected_latency_ms": route_decision.get("expected_latency_ms", 0),
        "model_band_hint": model_policy.get("model_band", ""),
        "semantic_model_hint": "",
    }
    route_hint = {
        "route_hint": route_hint_policy.get("hint_route", ""),
    }
    signal = build_signal_payload(
        task=_text(request.get("task")),
        command=_text(request.get("command")),
        metadata=dict(request.get("metadata", {})) if isinstance(request.get("metadata"), dict) else {},
        route_meta=route_meta,
        route_hint=route_hint,
        route_decision={
            **route_decision,
            "sticky_lane": route_hint_policy.get("sticky_route", ""),
            "ack_followup_candidate": route_hint_policy.get("ack_followup_candidate", False),
            "review_required": decision.get("review_policy", {}).get("required", False) if isinstance(decision.get("review_policy"), dict) else False,
        },
        runtime_switches=runtime_switches,
    )
    return {
        "schema_version": RECOMMENDATION_SCHEMA_VERSION,
        "internal_first": True,
        "signal": signal,
        "router_core": build_router_core_payload(
            route_meta=route_meta,
            route_decision=route_decision,
            review_required=bool(decision.get("review_policy", {}).get("required", False)) if isinstance(decision.get("review_policy"), dict) else False,
        ),
        "budget_planner": build_budget_planner_payload(
            budget_policy=budget_policy,
            model_policy=model_policy,
            route=_text(route_decision.get("route")),
        ),
        "model_intel": build_model_intel_payload(model_policy=model_policy),
        "adapter": build_adapter_payload(
            prompt_contract=prompt_contract,
            tool_policy=tool_policy,
            route_hint_policy=route_hint_policy,
            runtime_switches=runtime_switches,
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render OctoClaw internal-first auto-router recommendation")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    parser.add_argument("--metadata-json", default="")
    parser.add_argument("--route-hint-json", default="")
    parser.add_argument("--force-route", default="")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    metadata = json.loads(args.metadata_json) if args.metadata_json else {}
    route_hint = json.loads(args.route_hint_json) if args.route_hint_json else {}
    try:
        from octoclaw_policy import build_decision  # Offline CLI eval only — not a live path
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.octoclaw_policy import build_decision
    decision = build_decision(args.task, args.command, metadata, args.force_route, route_hint)
    print(json.dumps(decision["auto_router"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
