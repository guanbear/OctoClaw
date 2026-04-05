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


def _text(value: Any) -> str:
    return str(value or "").strip()


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
    return {
        "schema_version": ROUTER_CORE_SCHEMA_VERSION,
        "route": _text(route_decision.get("route")),
        "work_contract": _text(route_decision.get("work_contract")),
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
) -> dict[str, Any]:
    fallbacks = list(model_policy.get("fallbacks") or [])
    return {
        "schema_version": BUDGET_PLANNER_SCHEMA_VERSION,
        "target_model": _text(model_policy.get("selected_model")),
        "fallback_model": _text(fallbacks[0] if fallbacks else ""),
        "output_budget": _text(budget_policy.get("budget_cap")),
        "retry_budget": int(budget_policy.get("retry_cap", 0) or 0),
        "latency_target": _text(budget_policy.get("latency_target")),
        "max_workers": int(budget_policy.get("max_workers", 0) or 0),
        "upgrade_allowed": bool(budget_policy.get("upgrade_allowed")),
        "cost_ceiling": _text(budget_policy.get("budget_cap")),
    }


def build_model_intel_payload(*, model_policy: dict[str, Any]) -> dict[str, Any]:
    selected_model = _text(model_policy.get("selected_model"))
    provider = selected_model.split("/")[0] if "/" in selected_model else ""
    return {
        "schema_version": MODEL_INTEL_SCHEMA_VERSION,
        "selected_model": selected_model,
        "provider": provider,
        "model_band": _text(model_policy.get("model_band")),
        "selector_band": _text(model_policy.get("selector_band")),
        "selector_role": _text(model_policy.get("model_selector_role")),
        "source_files": {
            "catalog": MODEL_CATALOG_FILE,
            "policy": MODEL_POLICY_FILE,
            "health": MODEL_HEALTH_FILE,
            "speed": MODEL_SPEED_FILE,
            "plan_state": MODEL_PLAN_STATE_FILE,
            "benchmarks": MODEL_BENCHMARKS_FILE,
            "sources": MODEL_SOURCES_FILE,
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
        from octoclaw_policy import build_decision
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.octoclaw_policy import build_decision
    decision = build_decision(args.task, args.command, metadata, args.force_route, route_hint)
    print(json.dumps(decision["auto_router"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
