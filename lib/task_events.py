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
EVENT_IMPORTANCE = {
    "failed": "high",
    "task_failed": "high",
    "source_blocked": "high",
    "task_blocked": "high",
    "handoff_ready": "high",
    "user_notified": "high",
    "artifact_ready": "normal",
    "task_completed": "normal",
    "result_ready": "normal",
    "task_started": "normal",
    "task_running": "normal",
    "checkpoint": "normal",
    "progress_note": "low",
    "route_selected": "low",
    "dispatch_started": "low",
}


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


def _append_unique(items: list[str], value: str) -> list[str]:
    text = _text(value)
    if not text:
        return items
    if text not in items:
        items.append(text)
    return items


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
    binding_key = f"{origin}:{target}" if origin and target else ""
    return {
        "session_key": _text(session_key),
        "origin": origin,
        "target": target,
        "target_kind": target_kind,
        "thread_id": thread_id,
        "thread_key": thread_key,
        "binding_key": binding_key,
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
    thread_state: str = "",
    thread_title: str = "",
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
        "thread_state": _text(thread_state) or ("closed" if _text(action) in {"close", "archive"} else "active"),
        "thread_title": _text(thread_title) or _text(task_payload.get("title")) or _text(task_payload.get("task_description")),
    }

    try:
        payload = load_session_thread_map(path)
        bindings = payload.get("bindings", {}) if isinstance(payload.get("bindings", {}), dict) else {}
        threads = payload.get("threads", {}) if isinstance(payload.get("threads", {}), dict) else {}

        merged_binding = _merge_non_empty(bindings.get(key, {}), base)
        task_ids = bindings.get(key, {}).get("task_ids", [])
        if not isinstance(task_ids, list):
            task_ids = []
        merged_binding["task_ids"] = _append_unique(task_ids, base.get("task_id", ""))
        message_ids = bindings.get(key, {}).get("message_ids", [])
        if not isinstance(message_ids, list):
            message_ids = []
        merged_binding["message_ids"] = _append_unique(message_ids, base.get("message_id", ""))
        merged_binding["last_task_id"] = _text(base.get("task_id"))
        merged_binding["last_message_id"] = _text(base.get("message_id"))
        if merged_binding.get("thread_state") == "closed" and not _text(merged_binding.get("closed_at")):
            merged_binding["closed_at"] = merged_binding.get("updated_at", now_iso())
        bindings[key] = merged_binding
        thread_key = _text(merged_binding.get("thread_key"))
        if thread_key:
            thread_entry = _merge_non_empty(threads.get(thread_key, {}), {**merged_binding, "session_key": key})
            thread_task_ids = thread_entry.get("task_ids", [])
            if not isinstance(thread_task_ids, list):
                thread_task_ids = []
            thread_entry["task_ids"] = _append_unique(thread_task_ids, base.get("task_id", ""))
            thread_message_ids = thread_entry.get("message_ids", [])
            if not isinstance(thread_message_ids, list):
                thread_message_ids = []
            thread_entry["message_ids"] = _append_unique(thread_message_ids, base.get("message_id", ""))
            if thread_entry.get("thread_state") == "closed" and not _text(thread_entry.get("closed_at")):
                thread_entry["closed_at"] = merged_binding.get("updated_at", now_iso())
            threads[thread_key] = thread_entry

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
        "ownership_state": _text(((raw_task.get("ownership") or {}) if isinstance(raw_task.get("ownership"), dict) else {}).get("state")),
        "owner_id": _text(((raw_task.get("ownership") or {}) if isinstance(raw_task.get("ownership"), dict) else {}).get("owner_id")),
        "resume_state": _text(((raw_task.get("session_resume") or {}) if isinstance(raw_task.get("session_resume"), dict) else {}).get("resume_state")),
        "resume_key": _text(((raw_task.get("session_resume") or {}) if isinstance(raw_task.get("session_resume"), dict) else {}).get("resume_key")),
        "checklist_open_count": ((raw_task.get("checklist") or {}) if isinstance(raw_task.get("checklist"), dict) else {}).get("open_count", 0),
        "artifact_count": len(((raw_task.get("artifacts") or {}) if isinstance(raw_task.get("artifacts"), dict) else {})),
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


def task_events_for_task(task_id: str, *, path: str = TASK_EVENTS_FILE, limit: int = 200) -> list[dict[str, Any]]:
    key = _text(task_id)
    if not key:
        return []
    events = load_task_events(path, limit=limit)
    return [event for event in events if isinstance(event, dict) and _text(event.get("task_id")) == key]


def task_event_snapshot(
    task_id: str,
    *,
    path: str = TASK_EVENTS_FILE,
    limit: int = 200,
    preview_limit: int = 8,
) -> dict[str, Any]:
    events = task_events_for_task(task_id, path=path, limit=limit)
    summary = summarize_task_events(events)
    preview: list[dict[str, Any]] = []
    for event in events[-max(0, preview_limit) :]:
        kind = _text(event.get("kind")) or "unknown"
        preview.append(
            {
                "time": _text(event.get("time")),
                "kind": kind,
                "message": _text(event.get("message")),
                "importance": EVENT_IMPORTANCE.get(kind, "normal"),
            }
        )
    latest = events[-1] if events else {}
    return {
        "task_event_count": summary.get("task_event_count", 0),
        "kind_counts": summary.get("kind_counts", {}),
        "degraded_event_count": summary.get("degraded_event_count", 0),
        "latest_kind": _text(latest.get("kind")),
        "latest_time": _text(latest.get("time")),
        "preview": preview,
    }
