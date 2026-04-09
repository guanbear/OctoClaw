#!/usr/bin/env python3
"""Budget recommendation contract helpers."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "octoclaw.budget_recommendation/v1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def build_budget_recommendation(
    *,
    budget_policy: dict[str, Any],
    model_policy: dict[str, Any],
    route: str,
) -> dict[str, Any]:
    fallbacks = list(model_policy.get("fallbacks") or []) if isinstance(model_policy, dict) else []
    output_budget = _text((budget_policy or {}).get("budget_cap"))
    latency_target = _text((budget_policy or {}).get("latency_target"))
    max_workers = int((budget_policy or {}).get("max_workers", 0) or 0)
    retry_budget = int((budget_policy or {}).get("retry_cap", 0) or 0)
    route_name = _text(route)

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
        # Unknown routes should not silently appear budget-consistent just because
        # max_workers was parsed as a non-negative integer.
        workers_ok = False

    consistency = {
        "route": route_name,
        "route_matches_output_budget": bool(output_ok),
        "route_matches_latency_target": bool(latency_ok),
        "route_matches_worker_budget": bool(workers_ok),
        "retry_budget_valid": retry_budget >= 0,
        "route_budget_consistent": bool(output_ok and latency_ok and workers_ok and retry_budget >= 0),
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "target_model": _text((model_policy or {}).get("selected_model")),
        "fallback_model": _text(fallbacks[0] if fallbacks else ""),
        "output_budget": output_budget,
        "retry_budget": retry_budget,
        "latency_target": latency_target,
        "max_workers": max_workers,
        "reasoning_mode": _text((model_policy or {}).get("reasoning_effort")),
        "upgrade_allowed": bool((budget_policy or {}).get("upgrade_allowed")),
        "cost_ceiling": output_budget,
        "consistency": consistency,
    }
