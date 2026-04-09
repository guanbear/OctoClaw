#!/usr/bin/env python3
"""Build reply/delegation review packets from OpenClaw sessions and OctoClaw replay."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from collections import Counter
from zoneinfo import ZoneInfo


DEFAULT_TIMEZONE = "Asia/Shanghai"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build reply review packet from OpenClaw sessions")
    parser.add_argument("--sessions-index", required=True)
    parser.add_argument("--session-dir", required=True)
    parser.add_argument("--replay-log", default="")
    parser.add_argument("--task-state", default="")
    parser.add_argument("--day", default="")
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--limit", type=int, default=24)
    parser.add_argument("--output", default="")
    return parser.parse_args()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _safe_infer_route(prompt: str) -> dict:
    try:
        from octoclaw_route import infer_route  # type: ignore
    except ModuleNotFoundError:
        repo_root = Path(__file__).resolve().parents[1]
        lib_root = repo_root / "lib"
        for candidate in (str(lib_root), str(repo_root)):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
        try:
            from octoclaw_route import infer_route  # type: ignore
        except ModuleNotFoundError:
            from lib.octoclaw_route import infer_route  # type: ignore

    try:
        payload = infer_route(prompt)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _assistant_latency_seconds(user_timestamp: str, assistant_timestamp: str) -> float | None:
    user_at = parse_iso(user_timestamp)
    assistant_at = parse_iso(assistant_timestamp)
    if user_at is None or assistant_at is None:
        return None
    delta = (assistant_at - user_at).total_seconds()
    if delta < 0:
        return None
    return round(delta, 3)


def _explanation_risk(reply_text: str, expected_protected_lane: str, expected_task_class: str) -> bool:
    reply = str(reply_text or "")
    if not reply or not (expected_protected_lane or expected_task_class):
        return False
    delegation_markers = (
        "spawn_single",
        "octoclaw_dispatch",
        "子任务",
        "委派",
        "delegat",
        "dispatch",
    )
    return any(marker.lower() in reply.lower() for marker in delegation_markers)


def _selection_tags(
    *,
    protected_lane_misroute: bool,
    expected_route: str,
    expected_task_class: str,
    expected_protected_lane: str,
    policy_matched: bool,
    dispatch_called: bool,
    assistant_latency_seconds: float | None,
    user_prompt: str,
    assistant_reply: str,
    runner_lane_mismatch: bool,
) -> list[str]:
    tags: list[str] = []
    prompt = str(user_prompt or "").strip()
    if protected_lane_misroute:
        tags.append("protected_lane_misroute")
    if runner_lane_mismatch:
        tags.append("runner_lane_mismatch")
    if expected_route == "direct":
        tags.append("direct_path")
    if expected_route == "runner":
        tags.append("runner_path")
    if expected_protected_lane:
        tags.append("protected_lane")
        tags.append(expected_protected_lane)
    if expected_task_class:
        tags.append(expected_task_class)
    if len(prompt) <= 16:
        tags.append("casual_short")
    if expected_route == "direct" and not policy_matched:
        tags.append("direct_policy_missing")
    if expected_route == "direct" and assistant_latency_seconds is not None and assistant_latency_seconds >= 20:
        tags.append("direct_slow_reply")
    if dispatch_called:
        tags.append("dispatch_called")
    if _explanation_risk(assistant_reply, expected_protected_lane, expected_task_class):
        tags.append("delegation_explanation_risk")
    seen: set[str] = set()
    ordered: list[str] = []
    for tag in tags:
        if tag and tag not in seen:
            seen.add(tag)
            ordered.append(tag)
    return ordered


def _selection_score(case: dict) -> int:
    score = 0
    prompt = str(case.get("user_prompt", "") or "").strip()
    analysis = case.get("analysis") if isinstance(case.get("analysis"), dict) else {}
    tags = analysis.get("selection_tags") if isinstance(analysis.get("selection_tags"), list) else []
    tag_set = {str(tag or "") for tag in tags}
    if "protected_lane_misroute" in tag_set:
        score += 500
    if "runner_lane_mismatch" in tag_set:
        score += 420
    if "delegation_explanation_risk" in tag_set:
        score += 320
    if "direct_policy_missing" in tag_set:
        score += 260
    if "direct_slow_reply" in tag_set:
        score += 220
    if "protected_lane" in tag_set:
        score += 180
    if "dispatch_called" in tag_set:
        score += 120
    if "casual_short" in tag_set:
        score += 90
    if "direct_path" in tag_set:
        score += 70
    score += min(len(prompt), 80)
    return score


def select_cases(cases: list[dict], limit: int) -> list[dict]:
    ordered = sorted(
        cases,
        key=lambda item: (
            _selection_score(item),
            str(item.get("assistant_timestamp", "") or ""),
            str(item.get("user_timestamp", "") or ""),
        ),
        reverse=True,
    )
    return ordered[: max(1, limit)]


def summarize_selected_cases(cases: list[dict]) -> dict:
    metrics: Counter[str] = Counter()
    metric_keys = [
        "direct_case_count",
        "protected_lane_case_count",
        "protected_lane_misroute_count",
        "direct_policy_missing_count",
        "direct_slow_reply_count",
        "delegation_explanation_risk_count",
        "runner_case_count",
        "runner_lane_mismatch_count",
        "session_control_case_count",
        "control_observer_case_count",
        "casual_short_case_count",
    ]
    for case in cases:
        analysis = case.get("analysis") if isinstance(case.get("analysis"), dict) else {}
        tags = analysis.get("selection_tags") if isinstance(analysis.get("selection_tags"), list) else []
        tag_set = {str(tag or "") for tag in tags}
        if "direct_path" in tag_set:
            metrics["direct_case_count"] += 1
        if "protected_lane" in tag_set:
            metrics["protected_lane_case_count"] += 1
        if "protected_lane_misroute" in tag_set:
            metrics["protected_lane_misroute_count"] += 1
        if "direct_policy_missing" in tag_set:
            metrics["direct_policy_missing_count"] += 1
        if "direct_slow_reply" in tag_set:
            metrics["direct_slow_reply_count"] += 1
        if "delegation_explanation_risk" in tag_set:
            metrics["delegation_explanation_risk_count"] += 1
        if "runner_path" in tag_set:
            metrics["runner_case_count"] += 1
        if "runner_lane_mismatch" in tag_set:
            metrics["runner_lane_mismatch_count"] += 1
        if "session_control" in tag_set:
            metrics["session_control_case_count"] += 1
        if "control_observer" in tag_set:
            metrics["control_observer_case_count"] += 1
        if "casual_short" in tag_set:
            metrics["casual_short_case_count"] += 1
    return {key: int(metrics.get(key, 0)) for key in metric_keys}


def message_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                text = str(item.get("text", "") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""


def normalize_prompt(text: str) -> str:
    cleaned = str(text or "").strip()
    cleaned = re.sub(r"Sender \(untrusted metadata\):\s*```json\s*.*?```\s*", "", cleaned, flags=re.S)
    cleaned = re.sub(r"Conversation info \(untrusted metadata\):\s*```json\s*.*?```\s*", "", cleaned, flags=re.S)
    cleaned = re.sub(r"^(?:System:.*(?:\n|$))+", "", cleaned, flags=re.M)
    cleaned = re.sub(r"^\[[^\]]+\]\s*", "", cleaned, flags=re.M).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def normalize_assistant_text(text: str) -> str:
    cleaned = str(text or "").strip()
    cleaned = cleaned.replace("[[reply_to_current]]", "").strip()
    return cleaned


def looks_internal_prompt(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    markers = (
        "delegated run:",
        "allowed control tools:",
        "preferred skill bundle:",
        "system_preferred_route=",
        "worker_pool=",
        "protocol=heavy",
    )
    return any(marker in lowered for marker in markers)


def load_sessions_index(path: Path) -> dict[str, dict]:
    payload = json.loads(path.read_text())
    if isinstance(payload, dict):
        return {str(k): v for k, v in payload.items() if isinstance(v, dict)}
    if isinstance(payload, list):
        result: dict[str, dict] = {}
        for item in payload:
            if not isinstance(item, dict):
                continue
            session_key = str(item.get("sessionKey") or item.get("id") or "").strip()
            if session_key:
                result[session_key] = item
        return result
    return {}


def is_slack_session(session_key: str, session_meta: dict) -> bool:
    if ":slack:" in session_key:
        return True
    origin = session_meta.get("origin") or session_meta.get("source") or {}
    if isinstance(origin, dict):
        provider = str(origin.get("provider") or origin.get("surface") or "").lower()
        return provider == "slack"
    return False


def iter_jsonl(path: Path):
    for line in path.read_text(errors="ignore").splitlines():
        raw = line.strip()
        if not raw.startswith("{"):
            continue
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            continue


@dataclass
class Turn:
    session_key: str
    session_file: str
    session_origin: dict
    user_timestamp: str
    user_prompt: str
    assistant_timestamp: str
    assistant_reply: str


def collect_turns(
    *,
    sessions_index: dict[str, dict],
    session_dir: Path,
    review_day: datetime,
    tz: ZoneInfo,
) -> list[Turn]:
    turns: list[Turn] = []
    review_date = review_day.date()
    for session_key, meta in sessions_index.items():
        if not is_slack_session(session_key, meta):
            continue
        raw_session_file = Path(str(meta.get("sessionFile") or "").strip())
        session_file = raw_session_file
        if not session_file.is_absolute():
            session_file = session_dir / session_file
        elif not session_file.exists():
            session_file = session_dir / raw_session_file.name
        if not session_file.exists():
            continue
        messages: list[tuple[datetime | None, str, str]] = []
        for entry in iter_jsonl(session_file):
            if entry.get("type") != "message":
                continue
            payload = entry.get("message") or {}
            role = str(payload.get("role") or "").strip()
            if role not in {"user", "assistant"}:
                continue
            text = message_text(payload.get("content"))
            if not text:
                continue
            stamp = parse_iso(entry.get("timestamp") or payload.get("timestamp"))
            messages.append((stamp, role, text))
        current_user: tuple[datetime | None, str] | None = None
        assistant_fragments: list[tuple[datetime | None, str]] = []
        for stamp, role, text in messages:
            if role == "user":
                if current_user and assistant_fragments:
                    turns.append(
                        Turn(
                            session_key=session_key,
                            session_file=str(session_file),
                            session_origin=meta.get("origin") or {},
                            user_timestamp=current_user[0].isoformat() if current_user[0] else "",
                            user_prompt=normalize_prompt(current_user[1]),
                            assistant_timestamp=assistant_fragments[-1][0].isoformat() if assistant_fragments[-1][0] else "",
                            assistant_reply=normalize_assistant_text("\n\n".join(fragment for _, fragment in assistant_fragments if fragment.strip())),
                        )
                    )
                current_user = (stamp, text)
                assistant_fragments = []
                continue
            if current_user:
                assistant_fragments.append((stamp, text))
        if current_user and assistant_fragments:
            turns.append(
                Turn(
                    session_key=session_key,
                    session_file=str(session_file),
                    session_origin=meta.get("origin") or {},
                    user_timestamp=current_user[0].isoformat() if current_user[0] else "",
                    user_prompt=normalize_prompt(current_user[1]),
                    assistant_timestamp=assistant_fragments[-1][0].isoformat() if assistant_fragments[-1][0] else "",
                    assistant_reply=normalize_assistant_text("\n\n".join(fragment for _, fragment in assistant_fragments if fragment.strip())),
                )
            )

    filtered: list[Turn] = []
    for turn in turns:
        stamp = parse_iso(turn.user_timestamp)
        if not stamp:
            continue
        if stamp.astimezone(tz).date() != review_date:
            continue
        if not turn.user_prompt or not turn.assistant_reply:
            continue
        if looks_internal_prompt(turn.user_prompt):
            continue
        filtered.append(turn)
    return filtered


def load_replay_events(path: Path) -> list[dict]:
    if not path or not path.exists():
        return []
    events: list[dict] = []
    for line in path.read_text(errors="ignore").splitlines():
        raw = line.strip()
        if not raw.startswith("{"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def normalize_for_match(text: str) -> str:
    cleaned = normalize_prompt(text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    return cleaned


def _dispatch_materialization(event: dict | None) -> dict:
    if not isinstance(event, dict):
        return {}
    payload = event.get("materialization")
    return dict(payload) if isinstance(payload, dict) else {}


def _dispatch_capability_failure(event: dict | None) -> dict:
    if not isinstance(event, dict):
        return {}
    payload = event.get("capability_failure")
    if isinstance(payload, dict) and payload:
        return dict(payload)
    materialization = _dispatch_materialization(event)
    failure = materialization.get("capability_failure")
    return dict(failure) if isinstance(failure, dict) else {}


def _dispatch_materialized(event: dict | None) -> bool:
    if not isinstance(event, dict):
        return False
    materialization = _dispatch_materialization(event)
    if not materialization:
        return False
    if str(materialization.get("status", "") or "").strip().lower() != "materialized":
        return False
    route = str(event.get("route", "") or materialization.get("lane", "") or "").strip().lower()
    if route == "runner":
        return bool(str(materialization.get("runner_job_id", "") or "").strip()) or bool(materialization.get("executed", False))
    return bool(str(materialization.get("task_id", "") or materialization.get("child_spec_id", "") or "").strip()) or bool(materialization.get("executed", False))


def attach_replay(turns: list[Turn], replay_events: list[dict]) -> list[dict]:
    policy_events = [event for event in replay_events if event.get("event") == "policy_resolved"]
    dispatch_events = [event for event in replay_events if event.get("event") == "dispatch_called"]
    dispatch_by_session: dict[str, list[dict]] = {}
    for event in dispatch_events:
        dispatch_by_session.setdefault(str(event.get("sessionKey") or ""), []).append(event)

    results: list[dict] = []
    for turn in turns:
        normalized_prompt = normalize_for_match(turn.user_prompt)
        matched_policy = None
        for event in reversed(policy_events):
            event_prompt = normalize_for_match(str(event.get("prompt") or ""))
            if not event_prompt:
                continue
            if event_prompt == normalized_prompt or normalized_prompt in event_prompt or event_prompt in normalized_prompt:
                matched_policy = event
                break
        matched_dispatch = None
        for event in reversed(dispatch_by_session.get(turn.session_key, [])):
            route = str(event.get("route") or "")
            if route:
                matched_dispatch = event
                break
        protected_lane = str(matched_policy.get("protectedLane") or matched_policy.get("protected_lane") or "") if matched_policy else ""
        policy_route = str(matched_policy.get("route") or "") if matched_policy else ""
        dispatch_route = str(matched_dispatch.get("route") or "") if matched_dispatch else ""
        current_expected = _safe_infer_route(turn.user_prompt)
        expected_route = str(current_expected.get("route") or "")
        expected_task_class = str(current_expected.get("task_class") or "")
        expected_protected_lane = str(current_expected.get("protected_lane") or "")
        assistant_latency_seconds = _assistant_latency_seconds(turn.user_timestamp, turn.assistant_timestamp)
        policy_matched = bool(matched_policy)
        dispatch_called = bool(matched_dispatch)
        dispatch_materialized = _dispatch_materialized(matched_dispatch)
        dispatch_materialization = _dispatch_materialization(matched_dispatch)
        dispatch_capability_failure = _dispatch_capability_failure(matched_dispatch)
        protected_lane_misroute = bool(
            protected_lane and (
                dispatch_materialized
                or (policy_route and policy_route != "direct")
                or (dispatch_route and dispatch_route != "direct")
            )
        )
        runner_lane_mismatch = bool(
            policy_route == "runner" and (
                not dispatch_materialized
                or dispatch_route not in {"", "runner"}
            )
        )
        selection_tags = _selection_tags(
            protected_lane_misroute=protected_lane_misroute,
            expected_route=expected_route,
            expected_task_class=expected_task_class,
            expected_protected_lane=expected_protected_lane,
            policy_matched=policy_matched,
            dispatch_called=dispatch_called,
            assistant_latency_seconds=assistant_latency_seconds,
            user_prompt=turn.user_prompt,
            assistant_reply=turn.assistant_reply,
            runner_lane_mismatch=runner_lane_mismatch,
        )
        results.append(
            {
                "session_key": turn.session_key,
                "session_file": turn.session_file,
                "origin": turn.session_origin,
                "user_timestamp": turn.user_timestamp,
                "assistant_timestamp": turn.assistant_timestamp,
                "user_prompt": turn.user_prompt,
                "assistant_reply": turn.assistant_reply,
                "policy": {
                    "route": matched_policy.get("route") if matched_policy else "",
                    "system_preferred_route": matched_policy.get("systemPreferredRoute") if matched_policy else "",
                    "worker_pool": matched_policy.get("workerPool") if matched_policy else "",
                    "protected_lane": protected_lane,
                    "work_type": matched_policy.get("workType") if matched_policy else "",
                    "phase": matched_policy.get("phase") if matched_policy else "",
                    "review_required": matched_policy.get("reviewRequired") if matched_policy else False,
                    "sticky_applied": matched_policy.get("stickyApplied") if matched_policy else False,
                    "route_language_packs": matched_policy.get("routeLanguagePacks") if matched_policy else [],
                },
                "dispatch": {
                    "called": dispatch_called,
                    "materialized": dispatch_materialized,
                    "route": matched_dispatch.get("route") if matched_dispatch else "",
                    "worker_pool": matched_dispatch.get("workerPool") if matched_dispatch else "",
                    "protected_lane": matched_dispatch.get("protectedLane") if matched_dispatch else "",
                    "materialization": dispatch_materialization,
                    "capability_failure": dispatch_capability_failure,
                },
                "protected_lane_misroute": protected_lane_misroute,
                "runner_lane_mismatch": runner_lane_mismatch,
                "analysis": {
                    "assistant_latency_seconds": assistant_latency_seconds,
                    "policy_matched": policy_matched,
                    "current_expected": {
                        "route": expected_route,
                        "task_class": expected_task_class,
                        "protected_lane": expected_protected_lane,
                        "work_contract_hint": str(current_expected.get("work_contract_hint") or ""),
                    },
                    "selection_tags": selection_tags,
                    "selection_score": _selection_score(
                        {
                            "user_prompt": turn.user_prompt,
                            "assistant_timestamp": turn.assistant_timestamp,
                            "user_timestamp": turn.user_timestamp,
                            "analysis": {"selection_tags": selection_tags},
                        }
                    ),
                },
            }
        )
    return results


def build_packet(args: argparse.Namespace) -> dict:
    tz = ZoneInfo(args.timezone or DEFAULT_TIMEZONE)
    review_day = datetime.strptime(args.day, "%Y-%m-%d") if args.day else (datetime.now(tz) - timedelta(days=1))
    review_day = review_day.replace(tzinfo=tz)
    sessions_index = load_sessions_index(Path(args.sessions_index))
    turns = collect_turns(
        sessions_index=sessions_index,
        session_dir=Path(args.session_dir),
        review_day=review_day,
        tz=tz,
    )
    replay_events = load_replay_events(Path(args.replay_log)) if args.replay_log else []
    cases = attach_replay(turns, replay_events)
    selected_cases = select_cases(cases, args.limit)
    packet = {
        "schema_version": "octoclaw.reply_review_packet/v1",
        "day": review_day.strftime("%Y-%m-%d"),
        "timezone": str(tz),
        "sessions_considered": len([key for key, meta in sessions_index.items() if is_slack_session(key, meta)]),
        "case_count": len(selected_cases),
        "selection_metrics": summarize_selected_cases(selected_cases),
        "cases": selected_cases,
    }
    return packet


def main() -> int:
    args = parse_args()
    packet = build_packet(args)
    payload = json.dumps(packet, ensure_ascii=False, indent=2)
    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
