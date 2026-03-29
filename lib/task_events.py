#!/usr/bin/env python3
"""Task event log and IM thread binding helpers for OctoClaw."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any


WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
TASK_EVENTS_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "task-events.jsonl")
SESSION_THREAD_MAP_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "session-thread-map.json")
TASK_EVENT_SCHEMA_VERSION = "octoclaw.task_event/v1"
SESSION_THREAD_MAP_SCHEMA_VERSION = "octoclaw.session_thread_map/v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _merge_non_empty(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    for key, value in incoming.items():
        if value in (None, "", [], {}):
            continue
        merged[key] = value
    return merged


def _strip_agent_prefix(session_key: str) -> str:
    raw = _text(session_key)
    if not raw:
        return ""
    parts = raw.split(":")
    if len(parts) >= 3 and parts[0] == "agent":
        return ":".join(parts[2:])
    return raw


def _fallback_route_from_session_key(session_key: str) -> dict[str, Any]:
    stripped = _strip_agent_prefix(session_key)
    parts = [part for part in stripped.split(":") if part != ""]
    if not parts:
        return {}
    origin = parts[0].lower()
    target = ""
    thread_id = ""
    if len(parts) >= 3 and parts[1] in {"dm", "direct", "user"}:
        target = f"user:{parts[2]}"
        if len(parts) >= 5 and parts[3] in {"thread", "topic"}:
            thread_id = parts[4]
    elif len(parts) >= 3 and parts[1] in {"channel", "group", "room", "conversation", "space", "chat"}:
        target = f"{parts[1]}:{parts[2]}"
        if len(parts) >= 5 and parts[3] in {"thread", "topic"}:
            thread_id = parts[4]
    elif len(parts) >= 3 and parts[1] in {"thread", "topic"}:
        target = f"{parts[1]}:{parts[2]}"
    elif origin == "telegram" and len(parts) >= 3 and parts[1] == "group":
        target = parts[2]
        if len(parts) >= 5 and parts[3] in {"topic", "thread"}:
            thread_id = parts[4]
    return {"origin": origin, "target": target, "thread_id": thread_id}


def _ensure_parent(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def _load_json(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_json(path: str, payload: dict[str, Any]) -> None:
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def _append_jsonl(path: str, payload: dict[str, Any]) -> None:
    _ensure_parent(path)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def session_binding_from_route(session_key: str, route: dict[str, Any] | None = None) -> dict[str, Any]:
    parsed = route if isinstance(route, dict) and route else _fallback_route_from_session_key(session_key)
    origin = _text(parsed.get("origin"))
    target = _text(parsed.get("target"))
    thread_id = _text(parsed.get("thread_id"))
    target_kind = target.split(":", 1)[0].strip() if ":" in target else target
    thread_key = ""
    if origin and target:
        thread_key = f"{origin}:{target}:{thread_id or 'root'}"
    return {
        "session_key": _text(session_key),
        "origin": origin,
        "target": target,
        "target_kind": target_kind,
        "thread_id": thread_id,
        "thread_key": thread_key,
        "is_thread_bound": bool(thread_id),
    }


def load_session_thread_map(path: str = SESSION_THREAD_MAP_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", SESSION_THREAD_MAP_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("bindings", {})
    payload.setdefault("threads", {})
    return payload


def register_session_binding(
    session_key: str,
    route: dict[str, Any] | None = None,
    *,
    task: dict[str, Any] | None = None,
    source: str = "",
    message_id: str = "",
    action: str = "",
    path: str = SESSION_THREAD_MAP_FILE,
) -> dict[str, Any]:
    key = _text(session_key)
    binding = session_binding_from_route(key, route)
    if not key or not binding.get("target"):
        return {}

    task_payload = task if isinstance(task, dict) else {}
    base = {
        **binding,
        "updated_at": now_iso(),
        "source": _text(source),
        "task_id": _text(task_payload.get("id")),
        "route_name": _text(task_payload.get("route")),
        "worker_pool": _text(task_payload.get("worker_pool")),
        "message_id": _text(message_id),
        "last_action": _text(action),
    }

    try:
        payload = load_session_thread_map(path)
        bindings = payload.get("bindings", {}) if isinstance(payload.get("bindings", {}), dict) else {}
        threads = payload.get("threads", {}) if isinstance(payload.get("threads", {}), dict) else {}

        merged_binding = _merge_non_empty(bindings.get(key, {}), base)
        bindings[key] = merged_binding
        thread_key = _text(merged_binding.get("thread_key"))
        if thread_key:
            threads[thread_key] = _merge_non_empty(threads.get(thread_key, {}), {**merged_binding, "session_key": key})

        payload["schema_version"] = SESSION_THREAD_MAP_SCHEMA_VERSION
        payload["updated_at"] = merged_binding.get("updated_at", now_iso())
        payload["bindings"] = bindings
        payload["threads"] = threads
        _save_json(path, payload)
        return merged_binding
    except OSError:
        return base


def task_event_payload(task: dict[str, Any], kind: str, *, message: str = "", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    raw_task = task if isinstance(task, dict) else {}
    payload = {
        "schema_version": TASK_EVENT_SCHEMA_VERSION,
        "time": now_iso(),
        "kind": _text(kind),
        "message": _text(message),
        "task_id": _text(raw_task.get("id")),
        "parent_id": _text(raw_task.get("parent_id")),
        "task_kind": _text(raw_task.get("task_kind")),
        "session_key": _text(raw_task.get("session_key")),
        "session_origin": _text(raw_task.get("session_origin")),
        "route": _text(raw_task.get("route")),
        "worker_pool": _text(raw_task.get("worker_pool")),
        "work_type": _text(raw_task.get("work_type")),
        "phase": _text(raw_task.get("phase")),
        "status": _text(raw_task.get("status")),
        "lifecycle_state": _text(raw_task.get("lifecycle_state")),
        "outcome_state": _text(raw_task.get("outcome_state")),
        "handoff_state": _text(raw_task.get("handoff_state")),
        "deliverable_kind": _text(raw_task.get("deliverable_kind")),
        "observability_health": _text(raw_task.get("observability_health")),
        "summary": _text(raw_task.get("summary")),
        "user_safe_summary": _text(raw_task.get("user_safe_summary")),
        "blocked_reason": _text(raw_task.get("blocked_reason")),
        "report_path": _text(raw_task.get("report_path")),
        "model": _text(raw_task.get("model")),
    }
    binding = session_binding_from_route(payload["session_key"], extra.get("resolved_target") if isinstance(extra, dict) else None)
    payload["session_thread_key"] = _text(binding.get("thread_key"))
    payload["target"] = _text(binding.get("target"))
    payload["thread_id"] = _text(binding.get("thread_id"))
    if isinstance(extra, dict):
        payload.update({key: value for key, value in extra.items() if value not in (None, "")})
    return payload


def append_task_event(task: dict[str, Any], kind: str, *, message: str = "", extra: dict[str, Any] | None = None, path: str = TASK_EVENTS_FILE) -> dict[str, Any]:
    payload = task_event_payload(task, kind, message=message, extra=extra)
    if not payload.get("task_id") and not payload.get("session_key"):
        return {}
    try:
        _append_jsonl(path, payload)
    except OSError:
        return payload
    return payload


def load_task_events(path: str = TASK_EVENTS_FILE, *, limit: int = 200) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    events: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def summarize_task_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    sessions = set()
    thread_keys = set()
    degraded = 0
    for event in events:
        if not isinstance(event, dict):
            continue
        kind = _text(event.get("kind")) or "unknown"
        counts[kind] = counts.get(kind, 0) + 1
        session_key = _text(event.get("session_key"))
        thread_key = _text(event.get("session_thread_key"))
        if session_key:
            sessions.add(session_key)
        if thread_key:
            thread_keys.add(thread_key)
        if _text(event.get("observability_health")) and _text(event.get("observability_health")) != "healthy":
            degraded += 1
    return {
        "task_event_count": len([event for event in events if isinstance(event, dict)]),
        "kind_counts": counts,
        "session_count": len(sessions),
        "thread_count": len(thread_keys),
        "degraded_event_count": degraded,
    }
