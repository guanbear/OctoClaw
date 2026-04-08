#!/usr/bin/env python3
"""Curate replay sessions into portable eval/review cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:
    from feedback_loop import shared_case_fields
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.feedback_loop import shared_case_fields
from replay_review import FOCUS_CHOICES, build_review_payload
from replay_summary import DEFAULT_REPLAY_LOG, load_events


def _normalize_prompt(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def curate_cases(
    records: list[dict[str, Any]],
    *,
    dedupe_by: str,
    include_events: bool,
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    curated: list[dict[str, Any]] = []
    for record in records:
        key = record.get("session_key", "")
        if dedupe_by == "prompt":
            key = _normalize_prompt(str(record.get("prompt", "") or ""))
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        case = {
            "id": str(record.get("session_key") or f"case-{len(curated) + 1}"),
            "prompt": str(record.get("prompt") or ""),
            "expected_route": str(record.get("route") or ""),
            "system_preferred_route": str(record.get("system_preferred_route") or ""),
            "budget": {
                "budget_cap": str(record.get("budget_cap") or ""),
                "latency_target": str(record.get("latency_target") or ""),
                "max_workers": int(record.get("max_workers") or 0),
                "retry_cap": int(record.get("retry_cap") or 0),
            },
            "recommendation": {
                "recommended_route": str(record.get("recommended_route") or ""),
                "arbitration_strategy": str(record.get("arbitration_strategy") or ""),
                "arbitration_conflict_type": str(record.get("arbitration_conflict_type") or ""),
                "route_budget_consistent": record.get("route_budget_consistent"),
            },
            "route_hint": str(record.get("route_hint") or ""),
            "work_type": str(record.get("work_type") or ""),
            "phase": str(record.get("phase") or ""),
            "review_required": bool(record.get("review_required")),
            "confidence": record.get("confidence"),
            "tags": list(record.get("tags") or []),
            "route_language_packs": list(record.get("route_language_packs") or []),
            "source": {
                "session_key": str(record.get("session_key") or ""),
                "session_id": str(record.get("session_id") or ""),
                "first_event_at": str(record.get("first_event_at") or ""),
                "last_event_at": str(record.get("last_event_at") or ""),
                "event_count": int(record.get("event_count") or 0),
            },
        }
        case.update(
            shared_case_fields(
                prompt=str(record.get("prompt") or ""),
                route=str(record.get("route") or ""),
                worker_pool=str(record.get("worker_pool") or ""),
                route_language_packs=list(record.get("route_language_packs") or []),
                tags=list(record.get("tags") or []),
                review_required=bool(record.get("review_required")),
                blocked_events=list(record.get("blocked_events") or []),
                confidence=record.get("confidence"),
            )
        )
        if include_events:
            case["review"] = {
                "dispatch_called": bool(record.get("dispatch_called")),
                "route_hint_required": bool(record.get("route_hint_required")),
                "route_hint_submitted": bool(record.get("route_hint_submitted")),
                "sticky_applied": bool(record.get("sticky_applied")),
                "sticky_persisted": bool(record.get("sticky_persisted")),
                "blocked_events": list(record.get("blocked_events") or []),
                "reason": str(record.get("reason") or ""),
                "worker_pool": str(record.get("worker_pool") or ""),
                "budget_cap": str(record.get("budget_cap") or ""),
                "latency_target": str(record.get("latency_target") or ""),
                "max_workers": int(record.get("max_workers") or 0),
                "retry_cap": int(record.get("retry_cap") or 0),
                "recommended_route": str(record.get("recommended_route") or ""),
                "arbitration_strategy": str(record.get("arbitration_strategy") or ""),
                "arbitration_conflict_type": str(record.get("arbitration_conflict_type") or ""),
                "route_budget_consistent": record.get("route_budget_consistent"),
            }
        curated.append(case)
    return curated


def render_text(payload: dict[str, Any]) -> str:
    lines = [
        "OctoClaw Replay Curate",
        "",
        f"- Source: `{payload['source']['path']}` ({payload['source']['format']})",
        f"- Cases: `{payload['counts']['cases_selected']}` / `{payload['counts']['records_selected']}` records",
        f"- Dedupe: `{payload['filters']['dedupe_by']}`",
        f"- Focus: `{payload['filters']['focus']}`",
        "",
    ]
    for index, case in enumerate(payload["cases"], start=1):
        lines.append(
            f"{index}. `{case['id']}` · route `{case.get('expected_route') or 'n/a'}` · tags `{','.join(case.get('tags') or []) or 'none'}`"
        )
        lines.append(f"   prompt: {case.get('prompt') or '(no prompt)'}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Curate OctoClaw replay sessions into eval cases")
    parser.add_argument("--events", default=str(DEFAULT_REPLAY_LOG), help="Replay log path (JSONL or JSON array)")
    parser.add_argument("--format", choices=("text", "json"), default="json")
    parser.add_argument("--focus", choices=FOCUS_CHOICES, default="all")
    parser.add_argument("--route", default="", help="Only include sessions with the final route")
    parser.add_argument("--tag", default="", help="Only include sessions containing this review tag")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--dedupe-by", choices=("session", "prompt"), default="prompt")
    parser.add_argument("--include-events", action="store_true", help="Include extra review metadata in curated cases")
    parser.add_argument("--output", default="", help="Optional file to write curated output to")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    path = Path(args.events).expanduser().resolve()
    events, source_format, invalid_lines = load_events(path)
    review_payload = build_review_payload(
        events,
        source_path=str(path),
        source_format=source_format,
        invalid_lines=invalid_lines,
        focus=args.focus,
        route=args.route,
        tag=args.tag,
        limit=args.limit,
        offset=args.offset,
    )
    cases = curate_cases(review_payload["records"], dedupe_by=args.dedupe_by, include_events=args.include_events)
    payload = {
        "schema_version": "octoclaw.replay_curate/v1",
        "loop_phase": "curate",
        "source": review_payload["source"],
        "filters": {
            **review_payload["filters"],
            "dedupe_by": args.dedupe_by,
            "include_events": args.include_events,
        },
        "counts": {
            "records_selected": len(review_payload["records"]),
            "cases_selected": len(cases),
        },
        "cases": cases,
    }
    output = json.dumps(payload, ensure_ascii=False, indent=2) if args.format == "json" else render_text(payload)
    if args.output:
        Path(args.output).expanduser().resolve().write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
