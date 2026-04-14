#!/usr/bin/env python3
"""Route recommendation/arbitration contract helpers."""

from __future__ import annotations

from typing import Any


def _sorted_route_candidates(scores: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(scores, dict):
        return []
    ordered = sorted(scores.items(), key=lambda item: float(item[1] or 0), reverse=True)
    return [
        {
            "route": str(route or ""),
            "score": round(float(score or 0), 3),
        }
        for route, score in ordered[:2]
    ]


def build_route_recommendation(route_meta: dict[str, Any], resolved: dict[str, Any]) -> dict[str, Any]:
    features = route_meta.get("features", {}) if isinstance(route_meta.get("features"), dict) else {}
    reason_codes = [str(item or "") for item in list(route_meta.get("reason_codes", []) or [])]
    protected_lane = str(route_meta.get("protected_lane", "") or "").strip()
    repo_activity_hits = int(features.get("repo_activity_hits", 0) or 0)
    fresh_live_lookup = bool(features.get("fresh_live_lookup"))
    semantic_reason = str(route_meta.get("semantic_review_reason", "") or "")
    conflict_type = "" if fresh_live_lookup else ("repo_activity_lookup" if repo_activity_hits > 0 else semantic_reason)
    arbitration_required = False if (protected_lane or fresh_live_lookup) else bool(repo_activity_hits > 0 or route_meta.get("needs_semantic_review"))
    strategy = (
        "none"
        if (protected_lane or fresh_live_lookup)
        else ("rule_fallback" if repo_activity_hits > 0 else ("route_hint_or_future_tiny_judge" if route_meta.get("needs_semantic_review") else "none"))
    )
    resolved_by = "protected_lane" if protected_lane else ("base_policy" if fresh_live_lookup else ("rule_fallback" if repo_activity_hits > 0 else "base_policy"))
    reason_code_count = len(reason_codes)
    truncated_reason_codes = reason_codes[:8]
    return {
        "schema_version": "octoclaw.route_recommendation/v1",
        "recommended_route": str(resolved.get("route") or route_meta.get("route") or route_meta.get("system_preferred_route") or "direct"),
        "recommended_worker_pool": str(resolved.get("worker_pool", "") or ""),
        "recommended_work_type": str(resolved.get("work_type", "") or ""),
        "recommended_phase": str(resolved.get("phase", "") or ""),
        "recommended_model_band": str(resolved.get("model_band", "") or ""),
        "protected_lane": protected_lane,
        "bypass_delegated_optimization": bool(protected_lane),
        "work_contract_hint": str(route_meta.get("work_contract_hint", "") or ""),
        "top_candidates": _sorted_route_candidates(route_meta.get("scores", {})),
        "arbitration": {
            "required": arbitration_required,
            "strategy": strategy,
            "resolved_by": resolved_by,
            "conflict_type": conflict_type,
            "semantic_review_requested": bool(route_meta.get("needs_semantic_review")),
            "semantic_review_reason": semantic_reason,
            "score_margin": round(float(route_meta.get("score_margin", 0) or 0), 3),
            "tiny_judge_ready": False,
            "fallback_policy": "rule_only",
        },
        "reason_codes": truncated_reason_codes,
        "reason_code_count": reason_code_count,
        "reason_codes_truncated": reason_code_count > len(truncated_reason_codes),
    }
