#!/usr/bin/env python3
"""Build reply/delegation review packets from OpenClaw sessions and OctoClaw replay."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
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
    cleaned = re.sub(
        r"^Sender \(untrusted metadata\):\s*```json\s*.*?```\s*",
        "",
        cleaned,
        flags=re.S,
    )
    cleaned = re.sub(r"^(?:System:.*(?:\n|$))+", "", cleaned, flags=re.M)
    cleaned = re.sub(r"^\[[^\]]+\]\s*", "", cleaned).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def normalize_assistant_text(text: str) -> str:
    cleaned = str(text or "").strip()
    cleaned = cleaned.replace("[[reply_to_current]]", "").strip()
    return cleaned


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
        session_file = Path(str(meta.get("sessionFile") or "").strip())
        if not session_file.is_absolute():
            session_file = session_dir / session_file.name
        elif not session_file.exists():
            session_file = session_dir / session_file.name
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
                    "work_type": matched_policy.get("workType") if matched_policy else "",
                    "phase": matched_policy.get("phase") if matched_policy else "",
                    "review_required": matched_policy.get("reviewRequired") if matched_policy else False,
                    "sticky_applied": matched_policy.get("stickyApplied") if matched_policy else False,
                    "route_language_packs": matched_policy.get("routeLanguagePacks") if matched_policy else [],
                },
                "dispatch": {
                    "called": bool(matched_dispatch),
                    "route": matched_dispatch.get("route") if matched_dispatch else "",
                    "worker_pool": matched_dispatch.get("workerPool") if matched_dispatch else "",
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
    packet = {
        "schema_version": "octoclaw.reply_review_packet/v1",
        "day": review_day.strftime("%Y-%m-%d"),
        "timezone": str(tz),
        "sessions_considered": len([key for key, meta in sessions_index.items() if is_slack_session(key, meta)]),
        "case_count": min(len(cases), max(1, args.limit)),
        "cases": cases[: max(1, args.limit)],
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
