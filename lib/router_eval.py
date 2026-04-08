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


def evaluate_router_cases(cases: list[dict[str, Any]]) -> dict[str, Any]:
    recommendation_present = 0
    recommendation_matches = 0
    route_budget_consistent = 0
    route_budget_unknown = 0
    recommendation_missing = 0
    drift_cases: list[dict[str, Any]] = []
    by_expected = Counter()
    by_recommended = Counter()

    for case in cases:
        expected_route = str(case.get("expected_route") or "").strip()
        recommendation = case.get("recommendation", {}) if isinstance(case.get("recommendation"), dict) else {}
        budget = case.get("budget", {}) if isinstance(case.get("budget"), dict) else {}
        recommended_route = str(recommendation.get("recommended_route") or "").strip()
        raw_budget_consistent = recommendation.get("route_budget_consistent")
        budget_consistent = raw_budget_consistent if isinstance(raw_budget_consistent, bool) else None

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

        if (recommended_route and recommended_route != expected_route) or budget_consistent is False:
            drift_cases.append(
                {
                    "id": str(case.get("id") or ""),
                    "prompt": str(case.get("prompt") or ""),
                    "expected_route": expected_route,
                    "recommended_route": recommended_route,
                    "route_budget_consistent": budget_consistent,
                    "budget_cap": str(budget.get("budget_cap") or ""),
                    "latency_target": str(budget.get("latency_target") or ""),
                    "max_workers": int(budget.get("max_workers") or 0),
                    "tags": list(case.get("tags") or []),
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
            "recommendation_matches_expected_route": recommendation_matches,
            "recommendation_match_rate": recommendation_match_rate,
            "route_budget_consistent_cases": route_budget_consistent,
            "route_budget_unknown_cases": route_budget_unknown,
            "route_budget_consistency_rate": route_budget_consistency_rate,
            "drift_cases": len(drift_cases),
            "by_expected_route": dict(sorted(by_expected.items())),
            "by_recommended_route": dict(sorted(by_recommended.items())),
        },
        "drift_cases": drift_cases,
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
        f"- Drift cases: `{summary.get('drift_cases', 0)}`",
        "",
    ]
    for index, case in enumerate(payload.get("drift_cases", [])[:10], start=1):
        lines.append(
            f"{index}. `{case.get('id')}` · expected `{case.get('expected_route') or 'n/a'}` · recommended `{case.get('recommended_route') or 'missing'}` · budget_ok `{case.get('route_budget_consistent')}`"
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
