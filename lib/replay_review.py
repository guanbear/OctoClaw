#!/usr/bin/env python3
"""Review-friendly views over OctoClaw runtime-policy replay events."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from replay_summary import DEFAULT_REPLAY_LOG, TOOL_BLOCK_EVENTS, event_session_key, load_events, parse_timestamp


TASK_EVENTS = {"policy_resolved", "agent_end"}
ROUTE_HINT_EVENT = "route_hint_submitted"
DISPATCH_EVENT = "dispatch_called"
FOCUS_CHOICES = (
    "all",
    "blocked",
    "route_changed",
    "missing_hint",
    "sticky",
    "runner",
    "delegated",
    "direct",
    "no_dispatch",
)


def _event_at_key(event: dict[str, Any]) -> tuple[int, str]:
    timestamp = parse_timestamp(str(event.get("at", "") or ""))
    return (int(timestamp.timestamp()) if timestamp else -1, str(event.get("at", "") or ""))


def _latest(items: list[dict[str, Any]], *event_names: str) -> dict[str, Any] | None:
    filtered = [item for item in items if str(item.get("event", "") or "") in event_names]
    if not filtered:
        return None
    return max(filtered, key=_event_at_key)


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _find_route_language_packs(events: list[dict[str, Any]]) -> list[str]:
    for event in reversed(events):
        packs = event.get("routeLanguagePacks", event.get("route_language_packs"))
        if isinstance(packs, list):
            normalized = [str(item or "").strip() for item in packs if str(item or "").strip()]
            if normalized:
                return normalized
    return []


def _is_delegated_route(route: str) -> bool:
    return route in {"runner", "spawn_single", "spawn_multi"}


def derive_review_records(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        session_key = event_session_key(event)
        if session_key:
            by_session[session_key].append(event)

    records: list[dict[str, Any]] = []
    for session_key, session_events in by_session.items():
        ordered = sorted(session_events, key=_event_at_key)
        first_event = ordered[0]
        last_event = ordered[-1]
        task_event = _latest(ordered, "agent_end") or _latest(ordered, "policy_resolved")
        route_hint_event = _latest(ordered, ROUTE_HINT_EVENT)
        dispatch_event = _latest(ordered, DISPATCH_EVENT)
        blocked = [str(item.get("event", "") or "") for item in ordered if str(item.get("event", "") or "") in TOOL_BLOCK_EVENTS]

        prompt = _first_non_empty(
            task_event.get("prompt") if task_event else "",
            route_hint_event.get("prompt") if route_hint_event else "",
            first_event.get("prompt"),
        )
        route = _first_non_empty(
            task_event.get("route") if task_event else "",
            route_hint_event.get("finalRoute") if route_hint_event else "",
            dispatch_event.get("route") if dispatch_event else "",
        )
        system_preferred_route = _first_non_empty(
            task_event.get("systemPreferredRoute") if task_event else "",
            route_hint_event.get("systemPreferredRoute") if route_hint_event else "",
            dispatch_event.get("systemPreferredRoute") if dispatch_event else "",
        )
        worker_pool = _first_non_empty(
            task_event.get("workerPool") if task_event else "",
            route_hint_event.get("workerPool") if route_hint_event else "",
        )

        route_hint_required = bool(task_event.get("routeHintRequired")) if task_event else False
        route_hint_submitted = bool(task_event.get("routeHintSubmitted")) if task_event else bool(route_hint_event)
        sticky_applied = bool(task_event.get("stickyApplied")) if task_event else False
        sticky_persisted = bool(route_hint_event.get("stickyPersisted")) if route_hint_event else False
        delegated = bool(task_event.get("delegated")) if task_event else _is_delegated_route(route)

        tags: list[str] = []
        if blocked:
            tags.append("blocked")
        if route_hint_required and not route_hint_event:
            tags.append("missing_hint")
        if sticky_applied or sticky_persisted:
            tags.append("sticky")
        if route and system_preferred_route and route != system_preferred_route:
            tags.append("route_changed")
        if route == "runner":
            tags.append("runner")
        elif delegated:
            tags.append("delegated")
        elif route == "direct":
            tags.append("direct")
        if delegated and route != "runner" and dispatch_event is None:
            tags.append("no_dispatch")

        records.append(
            {
                "session_key": session_key,
                "session_id": _first_non_empty(last_event.get("sessionId"), first_event.get("sessionId")),
                "first_event_at": str(first_event.get("at", "") or ""),
                "last_event_at": str(last_event.get("at", "") or ""),
                "event_count": len(ordered),
                "prompt": prompt,
                "route": route,
                "system_preferred_route": system_preferred_route,
                "worker_pool": worker_pool,
                "route_hint": _first_non_empty(route_hint_event.get("routeHint") if route_hint_event else ""),
                "work_type": _first_non_empty(route_hint_event.get("workType") if route_hint_event else ""),
                "phase": _first_non_empty(route_hint_event.get("phase") if route_hint_event else ""),
                "review_required": bool(route_hint_event.get("reviewRequired")) if route_hint_event else False,
                "confidence": route_hint_event.get("confidence") if route_hint_event else None,
                "reason": _first_non_empty(route_hint_event.get("reason") if route_hint_event else ""),
                "route_hint_required": route_hint_required,
                "route_hint_submitted": route_hint_submitted,
                "dispatch_called": dispatch_event is not None,
                "sticky_applied": sticky_applied,
                "sticky_persisted": sticky_persisted,
                "blocked_events": blocked,
                "route_language_packs": _find_route_language_packs(ordered),
                "tags": tags,
            }
        )

    return sorted(records, key=lambda item: (item.get("last_event_at", ""), item.get("session_key", "")), reverse=True)


def filter_review_records(
    records: list[dict[str, Any]],
    *,
    focus: str,
    route: str,
    tag: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    selected = records
    if focus != "all":
        selected = [item for item in selected if focus in (item.get("tags") or [])]
    if route:
        selected = [item for item in selected if str(item.get("route", "") or "") == route]
    if tag:
        selected = [item for item in selected if tag in (item.get("tags") or [])]
    if offset > 0:
        selected = selected[offset:]
    if limit >= 0:
        selected = selected[:limit]
    return selected


def build_review_payload(
    events: list[dict[str, Any]],
    *,
    source_path: str,
    source_format: str,
    invalid_lines: int,
    focus: str,
    route: str,
    tag: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    records = derive_review_records(events)
    filtered = filter_review_records(records, focus=focus, route=route, tag=tag, limit=limit, offset=offset)
    return {
        "source": {
            "path": source_path,
            "format": source_format,
            "invalid_lines": invalid_lines,
        },
        "filters": {
            "focus": focus,
            "route": route,
            "tag": tag,
            "limit": limit,
            "offset": offset,
        },
        "counts": {
            "sessions_total": len(records),
            "sessions_selected": len(filtered),
            "by_tag": dict(sorted(Counter(tag_name for item in records for tag_name in (item.get("tags") or [])).items())),
            "by_route": dict(sorted(Counter(str(item.get("route", "") or "") for item in records if str(item.get("route", "") or "")).items())),
        },
        "records": filtered,
    }


def render_review_text(payload: dict[str, Any]) -> str:
    lines = [
        "OctoClaw Replay Review",
        "",
        f"- Source: `{payload['source']['path']}` ({payload['source']['format']})",
        f"- Sessions total: `{payload['counts']['sessions_total']}`",
        f"- Sessions selected: `{payload['counts']['sessions_selected']}`",
        f"- Focus: `{payload['filters']['focus']}`",
    ]
    if payload["filters"]["route"]:
        lines.append(f"- Route filter: `{payload['filters']['route']}`")
    if payload["filters"]["tag"]:
        lines.append(f"- Tag filter: `{payload['filters']['tag']}`")
    lines.extend(
        [
            f"- Tags: `{json.dumps(payload['counts']['by_tag'], ensure_ascii=False)}`",
            f"- Routes: `{json.dumps(payload['counts']['by_route'], ensure_ascii=False)}`",
            "",
        ]
    )
    for index, record in enumerate(payload["records"], start=1):
        lines.extend(
            [
                f"{index}. `{record['session_key']}` · route `{record.get('route') or 'n/a'}` · tags `{','.join(record.get('tags') or []) or 'none'}`",
                f"   prompt: {record.get('prompt') or '(no prompt)'}",
                "   details: "
                + f"preferred={record.get('system_preferred_route') or 'n/a'}"
                + f" · hint={record.get('route_hint') or 'n/a'}"
                + f" · dispatch={'yes' if record.get('dispatch_called') else 'no'}"
                + f" · sticky={'yes' if record.get('sticky_applied') or record.get('sticky_persisted') else 'no'}"
                + f" · packs={','.join(record.get('route_language_packs') or []) or 'n/a'}",
            ]
        )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Review OctoClaw replay sessions")
    parser.add_argument("--events", default=str(DEFAULT_REPLAY_LOG), help="Replay log path (JSONL or JSON array)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--focus", choices=FOCUS_CHOICES, default="all")
    parser.add_argument("--route", default="", help="Only include sessions with the final route")
    parser.add_argument("--tag", default="", help="Only include sessions containing this review tag")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--output", default="", help="Optional file to write the review payload to")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    path = Path(args.events).expanduser().resolve()
    events, source_format, invalid_lines = load_events(path)
    payload = build_review_payload(
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
    output = json.dumps(payload, ensure_ascii=False, indent=2) if args.format == "json" else render_review_text(payload)
    if args.output:
        Path(args.output).expanduser().resolve().write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
