#!/usr/bin/env python3
"""Replay-driven router eval baseline for OctoClaw."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from replay_curate import curate_cases
from replay_review import FOCUS_CHOICES, build_review_payload
from replay_summary import DEFAULT_REPLAY_LOG, load_events


def _normalize_route(value: Any) -> str:
    return str(value or "").strip()


def classify_case_drift(case: dict[str, Any]) -> dict[str, Any]:
    expected_route = _normalize_route(case.get("expected_route"))
    recommendation = case.get("recommendation", {}) if isinstance(case.get("recommendation"), dict) else {}
    budget = case.get("budget", {}) if isinstance(case.get("budget"), dict) else {}
    outcome = case.get("outcome", {}) if isinstance(case.get("outcome"), dict) else {}
    recommended_route = _normalize_route(recommendation.get("recommended_route"))
    execution_contract = _normalize_route(outcome.get("execution_contract"))
    resolved_execution_contract = _normalize_route(outcome.get("resolved_execution_contract"))
    recommended_model = _normalize_route(outcome.get("recommended_model"))
    resolved_model = _normalize_route(outcome.get("resolved_model"))
    queue_pressure_band = _normalize_route(outcome.get("queue_pressure_band"))
    quota_pressure_band = _normalize_route(outcome.get("quota_pressure_band"))
    validation_outcome = _normalize_route(outcome.get("validation_outcome"))
    fallback_taken = bool(outcome.get("fallback_taken"))
    raw_budget_consistent = recommendation.get("route_budget_consistent")
    budget_consistent = raw_budget_consistent if isinstance(raw_budget_consistent, bool) else None

    if not recommended_route:
        route_drift = "missing_recommendation"
    elif recommended_route == expected_route:
        route_drift = "match"
    else:
        route_drift = "route_mismatch"

    if budget_consistent is True:
        budget_drift = "match"
    elif budget_consistent is False:
        budget_drift = "budget_mismatch"
    else:
        budget_drift = "unknown"

    if route_drift == "match" and budget_drift == "match":
        overall = "match"
    elif route_drift == "missing_recommendation" and budget_drift == "unknown":
        overall = "missing_recommendation"
    elif route_drift == "route_mismatch" and budget_drift == "budget_mismatch":
        overall = "route_and_budget_mismatch"
    elif route_drift == "route_mismatch":
        overall = "route_mismatch"
    elif budget_drift == "budget_mismatch":
        overall = "budget_mismatch"
    else:
        overall = "unknown"

    if execution_contract and resolved_execution_contract and execution_contract != resolved_execution_contract:
        resolution_drift = "execution_contract_mismatch"
    elif recommended_model and resolved_model and recommended_model != resolved_model:
        resolution_drift = "model_resolution_mismatch"
    elif fallback_taken:
        resolution_drift = "fallback_taken"
    else:
        resolution_drift = "match" if (execution_contract or resolved_execution_contract or recommended_model or resolved_model) else "unknown"

    evidence = {
        "schema_version": "octoclaw.router_eval.calibration_evidence/v1",
        "expected_route": expected_route,
        "recommended_route": recommended_route,
        "system_preferred_route": _normalize_route(case.get("system_preferred_route")),
        "budget_cap": _normalize_route(budget.get("budget_cap")),
        "latency_target": _normalize_route(budget.get("latency_target")),
        "max_workers": int(budget.get("max_workers") or 0),
        "retry_cap": int(budget.get("retry_cap") or 0),
        "route_drift_class": route_drift,
        "budget_drift_class": budget_drift,
        "resolution_drift_class": resolution_drift,
        "overall_drift_class": overall,
        "route_budget_consistent": budget_consistent,
        "execution_contract": execution_contract,
        "resolved_execution_contract": resolved_execution_contract,
        "recommended_model": recommended_model,
        "resolved_model": resolved_model,
        "fallback_taken": fallback_taken,
        "queue_pressure_band": queue_pressure_band,
        "quota_pressure_band": quota_pressure_band,
        "validation_outcome": validation_outcome,
        "tags": list(case.get("tags") or []),
    }
    return {
        "expected_route": expected_route,
        "recommended_route": recommended_route,
        "route_budget_consistent": budget_consistent,
        "route_drift_class": route_drift,
        "budget_drift_class": budget_drift,
        "resolution_drift_class": resolution_drift,
        "overall_drift_class": overall,
        "calibration_evidence": evidence,
    }


def build_tuning_inputs(cases: list[dict[str, Any]]) -> dict[str, Any]:
    route_transition_counts: Counter[tuple[str, str]] = Counter()
    route_resolution_transitions: Counter[tuple[str, str]] = Counter()
    model_resolution_transitions: Counter[tuple[str, str]] = Counter()
    budget_caps_by_expected: Counter[tuple[str, str]] = Counter()
    latency_targets_by_expected: Counter[tuple[str, str]] = Counter()
    inconsistent_cases_by_expected: Counter[str] = Counter()
    missing_recommendation_by_expected: Counter[str] = Counter()
    overall_drift_breakdown: Counter[str] = Counter()
    resolution_drift_breakdown: Counter[str] = Counter()
    queue_pressure_on_drift: Counter[str] = Counter()
    quota_pressure_on_drift: Counter[str] = Counter()
    fallback_by_expected: Counter[str] = Counter()

    for case in cases:
        drift = classify_case_drift(case)
        expected_route = drift["expected_route"] or "unknown"
        recommended_route = drift["recommended_route"] or "missing"
        budget = case.get("budget", {}) if isinstance(case.get("budget"), dict) else {}
        evidence = drift["calibration_evidence"]
        budget_cap = _normalize_route(budget.get("budget_cap")) or "unknown"
        latency_target = _normalize_route(budget.get("latency_target")) or "unknown"
        route_transition_counts[(expected_route, recommended_route)] += 1
        route_resolution_transitions[(expected_route, _normalize_route(evidence.get("resolved_execution_contract")) or "unknown")] += 1
        model_resolution_transitions[(_normalize_route(evidence.get("recommended_model")) or "unknown", _normalize_route(evidence.get("resolved_model")) or "unknown")] += 1
        budget_caps_by_expected[(expected_route, budget_cap)] += 1
        latency_targets_by_expected[(expected_route, latency_target)] += 1
        overall_drift_breakdown[drift["overall_drift_class"]] += 1
        resolution_drift_breakdown[drift["resolution_drift_class"]] += 1
        if drift["budget_drift_class"] == "budget_mismatch":
            inconsistent_cases_by_expected[expected_route] += 1
        if drift["route_drift_class"] == "missing_recommendation":
            missing_recommendation_by_expected[expected_route] += 1
        if bool(evidence.get("fallback_taken")):
            fallback_by_expected[expected_route] += 1
        if drift["overall_drift_class"] not in {"match", "unknown", "missing_recommendation"}:
            queue_pressure_on_drift[_normalize_route(evidence.get("queue_pressure_band")) or "unknown"] += 1
            quota_pressure_on_drift[_normalize_route(evidence.get("quota_pressure_band")) or "unknown"] += 1

    def _pairs(counter: Counter[tuple[str, str]]) -> list[dict[str, Any]]:
        return [
            {"expected_route": left, "value": right, "count": count}
            for (left, right), count in sorted(counter.items())
        ]

    return {
        "schema_version": "octoclaw.router_eval.tuning_inputs/v1",
        "route_transition_counts": [
            {"expected_route": expected, "recommended_route": recommended, "count": count}
            for (expected, recommended), count in sorted(route_transition_counts.items())
        ],
        "route_resolution_transitions": [
            {"expected_route": expected, "resolved_execution_contract": resolved, "count": count}
            for (expected, resolved), count in sorted(route_resolution_transitions.items())
        ],
        "model_resolution_transitions": [
            {"recommended_model": recommended, "resolved_model": resolved, "count": count}
            for (recommended, resolved), count in sorted(model_resolution_transitions.items())
        ],
        "budget_caps_by_expected_route": _pairs(budget_caps_by_expected),
        "latency_targets_by_expected_route": _pairs(latency_targets_by_expected),
        "inconsistent_cases_by_expected_route": dict(sorted(inconsistent_cases_by_expected.items())),
        "missing_recommendation_by_expected_route": dict(sorted(missing_recommendation_by_expected.items())),
        "overall_drift_breakdown": dict(sorted(overall_drift_breakdown.items())),
        "resolution_drift_breakdown": dict(sorted(resolution_drift_breakdown.items())),
        "queue_pressure_band_on_drift": dict(sorted(queue_pressure_on_drift.items())),
        "quota_pressure_band_on_drift": dict(sorted(quota_pressure_on_drift.items())),
        "fallback_by_expected_route": dict(sorted(fallback_by_expected.items())),
    }


def build_tuning_suggestions(tuning_inputs: dict[str, Any]) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    for route, count in sorted((tuning_inputs.get("missing_recommendation_by_expected_route") or {}).items()):
        if int(count or 0) <= 0:
            continue
        suggestions.append(
            {
                "kind": "missing_recommendation_coverage",
                "expected_route": route,
                "count": int(count),
                "action": f"Expand recommendation coverage for `{route}` cases before adjusting thresholds.",
            }
        )
    for route, count in sorted((tuning_inputs.get("inconsistent_cases_by_expected_route") or {}).items()):
        if int(count or 0) <= 0:
            continue
        suggestions.append(
            {
                "kind": "budget_ladder_review",
                "expected_route": route,
                "count": int(count),
                "action": f"Review budget ladder and latency targets for `{route}`.",
            }
        )
    for item in tuning_inputs.get("route_transition_counts", []) or []:
        expected = _normalize_route(item.get("expected_route"))
        recommended = _normalize_route(item.get("recommended_route"))
        count = int(item.get("count") or 0)
        if not expected or expected == recommended or recommended in {"", "missing"} or count <= 0:
            continue
        suggestions.append(
            {
                "kind": "route_ladder_review",
                "expected_route": expected,
                "recommended_route": recommended,
                "count": count,
                "action": f"Review why `{expected}` cases are being recommended as `{recommended}`.",
            }
        )
    for item in tuning_inputs.get("route_resolution_transitions", []) or []:
        expected = _normalize_route(item.get("expected_route"))
        resolved = _normalize_route(item.get("resolved_execution_contract"))
        count = int(item.get("count") or 0)
        if not expected or not resolved or expected == resolved or resolved == "unknown" or count <= 0:
            continue
        suggestions.append(
            {
                "kind": "resolution_clamp_review",
                "expected_route": expected,
                "resolved_execution_contract": resolved,
                "count": count,
                "action": f"Review runtime resolution/clamp path because `{expected}` cases are resolving as `{resolved}`.",
            }
        )
    for item in tuning_inputs.get("model_resolution_transitions", []) or []:
        recommended = _normalize_route(item.get("recommended_model"))
        resolved = _normalize_route(item.get("resolved_model"))
        count = int(item.get("count") or 0)
        if not recommended or not resolved or recommended == resolved or "unknown" in {recommended, resolved} or count <= 0:
            continue
        suggestions.append(
            {
                "kind": "model_resolution_review",
                "recommended_model": recommended,
                "resolved_model": resolved,
                "count": count,
                "action": f"Review model-intel weighting or runtime fallback because `{recommended}` is resolving as `{resolved}`.",
            }
        )
    for band, count in sorted((tuning_inputs.get("quota_pressure_band_on_drift") or {}).items()):
        if band in {"", "unknown", "none"} or int(count or 0) <= 0:
            continue
        suggestions.append(
            {
                "kind": "quota_pressure_review",
                "quota_pressure_band": band,
                "count": int(count),
                "action": f"Review quota/cooldown handling because drift clusters under quota pressure `{band}`.",
            }
        )
    for band, count in sorted((tuning_inputs.get("queue_pressure_band_on_drift") or {}).items()):
        if band in {"", "unknown", "none"} or int(count or 0) <= 0:
            continue
        suggestions.append(
            {
                "kind": "queue_pressure_review",
                "queue_pressure_band": band,
                "count": int(count),
                "action": f"Review runner capacity or spawn gating because drift clusters under queue pressure `{band}`.",
            }
        )
    return suggestions[:12]


def evaluate_router_cases(cases: list[dict[str, Any]]) -> dict[str, Any]:
    recommendation_present = 0
    recommendation_matches = 0
    route_budget_consistent = 0
    route_budget_unknown = 0
    recommendation_missing = 0
    drift_cases: list[dict[str, Any]] = []
    by_expected = Counter()
    by_recommended = Counter()
    route_drift_breakdown = Counter()
    budget_drift_breakdown = Counter()
    resolution_drift_breakdown = Counter()
    overall_drift_breakdown = Counter()
    calibration_ready = 0
    fallback_taken_count = 0

    for case in cases:
        drift = classify_case_drift(case)
        expected_route = drift["expected_route"]
        recommended_route = drift["recommended_route"]
        budget_consistent = drift["route_budget_consistent"]
        evidence = drift["calibration_evidence"]
        budget = case.get("budget", {}) if isinstance(case.get("budget"), dict) else {}

        if expected_route:
            by_expected[expected_route] += 1
        if recommended_route:
            by_recommended[recommended_route] += 1
            recommendation_present += 1
            if recommended_route == expected_route:
                recommendation_matches += 1
        else:
            recommendation_missing += 1
        if budget_consistent is True:
            route_budget_consistent += 1
        elif budget_consistent is None:
            route_budget_unknown += 1

        route_drift_breakdown[drift["route_drift_class"]] += 1
        budget_drift_breakdown[drift["budget_drift_class"]] += 1
        resolution_drift_breakdown[drift["resolution_drift_class"]] += 1
        overall_drift_breakdown[drift["overall_drift_class"]] += 1
        if evidence.get("fallback_taken"):
            fallback_taken_count += 1
        if drift["overall_drift_class"] != "missing_recommendation":
            calibration_ready += 1

        if drift["overall_drift_class"] not in {"match", "unknown", "missing_recommendation"}:
            drift_cases.append(
                {
                    "id": str(case.get("id") or ""),
                    "prompt": str(case.get("prompt") or ""),
                    "expected_route": expected_route,
                    "recommended_route": recommended_route,
                    "route_budget_consistent": budget_consistent,
                    "route_drift_class": drift["route_drift_class"],
                    "budget_drift_class": drift["budget_drift_class"],
                    "resolution_drift_class": drift["resolution_drift_class"],
                    "overall_drift_class": drift["overall_drift_class"],
                    "budget_cap": str(budget.get("budget_cap") or ""),
                    "latency_target": str(budget.get("latency_target") or ""),
                    "max_workers": int(budget.get("max_workers") or 0),
                    "tags": list(case.get("tags") or []),
                    "calibration_evidence": evidence,
                }
            )

    total = len(cases)
    recommendation_match_rate = round(recommendation_matches / recommendation_present, 6) if recommendation_present else 0.0
    route_budget_consistency_rate = round(route_budget_consistent / total, 6) if total else 0.0
    return {
        "summary": {
            "total_cases": total,
            "recommendation_present": recommendation_present,
            "recommendation_missing": recommendation_missing,
            "calibration_ready_cases": calibration_ready,
            "recommendation_matches_expected_route": recommendation_matches,
            "recommendation_match_rate": recommendation_match_rate,
            "route_budget_consistent_cases": route_budget_consistent,
            "route_budget_unknown_cases": route_budget_unknown,
            "route_budget_consistency_rate": route_budget_consistency_rate,
            "fallback_taken_count": fallback_taken_count,
            "drift_cases": len(drift_cases),
            "by_expected_route": dict(sorted(by_expected.items())),
            "by_recommended_route": dict(sorted(by_recommended.items())),
            "route_drift_breakdown": dict(sorted(route_drift_breakdown.items())),
            "budget_drift_breakdown": dict(sorted(budget_drift_breakdown.items())),
            "resolution_drift_breakdown": dict(sorted(resolution_drift_breakdown.items())),
            "overall_drift_breakdown": dict(sorted(overall_drift_breakdown.items())),
        },
        "drift_cases": drift_cases,
        "tuning_inputs": build_tuning_inputs(cases),
    }


def render_text(payload: dict[str, Any]) -> str:
    summary = payload.get("summary", {}) if isinstance(payload.get("summary"), dict) else {}
    lines = [
        "OctoClaw Router Eval",
        "",
        f"- Source: `{payload['source']['path']}` ({payload['source']['format']})",
        f"- Cases: `{summary.get('total_cases', 0)}`",
        f"- Recommendation present: `{summary.get('recommendation_present', 0)}`",
        f"- Recommendation match rate: `{summary.get('recommendation_match_rate', 0)}`",
        f"- Route-budget consistency rate: `{summary.get('route_budget_consistency_rate', 0)}`",
        f"- Resolution drift breakdown: `{summary.get('resolution_drift_breakdown', {})}`",
        f"- Drift cases: `{summary.get('drift_cases', 0)}`",
        "",
    ]
    for index, case in enumerate(payload.get("drift_cases", [])[:10], start=1):
        lines.append(
            f"{index}. `{case.get('id')}` · expected `{case.get('expected_route') or 'n/a'}` · recommended `{case.get('recommended_route') or 'missing'}` · drift `{case.get('overall_drift_class')}` · budget_ok `{case.get('route_budget_consistent')}`"
        )
        lines.append(f"   prompt: {case.get('prompt') or '(no prompt)'}")
    return "\n".join(lines)


def build_payload(
    *,
    events_path: Path,
    focus: str,
    route: str,
    tag: str,
    limit: int,
    offset: int,
    dedupe_by: str,
) -> dict[str, Any]:
    events, source_format, invalid_lines = load_events(events_path)
    review_payload = build_review_payload(
        events,
        source_path=str(events_path),
        source_format=source_format,
        invalid_lines=invalid_lines,
        focus=focus,
        route=route,
        tag=tag,
        limit=limit,
        offset=offset,
    )
    cases = curate_cases(review_payload["records"], dedupe_by=dedupe_by, include_events=True)
    evaluation = evaluate_router_cases(cases)
    return {
        "schema_version": "octoclaw.router_eval/v1",
        "source": review_payload["source"],
        "filters": {
            **review_payload["filters"],
            "dedupe_by": dedupe_by,
        },
        "summary": evaluation["summary"],
        "drift_cases": evaluation["drift_cases"],
        "tuning_inputs": evaluation["tuning_inputs"],
        "tuning_suggestions": build_tuning_suggestions(evaluation["tuning_inputs"]),
        "cases": cases,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Replay-driven router eval baseline for OctoClaw")
    parser.add_argument("--events", default=str(DEFAULT_REPLAY_LOG), help="Replay log path (JSONL or JSON array)")
    parser.add_argument("--format", choices=("text", "json"), default="json")
    parser.add_argument("--focus", choices=FOCUS_CHOICES, default="all")
    parser.add_argument("--route", default="", help="Only include sessions with the final route")
    parser.add_argument("--tag", default="", help="Only include sessions containing this review tag")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--dedupe-by", choices=("session", "prompt"), default="prompt")
    parser.add_argument("--output", default="", help="Optional file to write eval output to")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    path = Path(args.events).expanduser().resolve()
    payload = build_payload(
        events_path=path,
        focus=args.focus,
        route=args.route,
        tag=args.tag,
        limit=args.limit,
        offset=args.offset,
        dedupe_by=args.dedupe_by,
    )
    output = json.dumps(payload, ensure_ascii=False, indent=2) if args.format == "json" else render_text(payload)
    if args.output:
        Path(args.output).expanduser().resolve().write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
