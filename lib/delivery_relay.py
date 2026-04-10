#!/usr/bin/env python3
"""Shared delivery relay ledger helpers for OctoClaw."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

try:
    from task_events import append_task_event
except ModuleNotFoundError:  # pragma: no cover
    from lib.task_events import append_task_event


TERMINAL_RELAY_EVENTS = {
    "delivery_observed",
    "delivery_compensated",
    "delivery_reconciled_delivered",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def resolve_workspace() -> str:
    return _text(os.environ.get("WORKSPACE")) or "/workspace"


def resolve_delivery_relay_path(workspace: str = "") -> str:
    root = _text(workspace) or resolve_workspace()
    return str(Path(root) / "tmp" / "octopus" / "delivery-relay.jsonl")


def resolve_task_events_path(workspace: str = "", relay_path: str = "") -> str:
    relay = Path(_text(relay_path)) if _text(relay_path) else None
    if relay:
        return str(relay.with_name("task-events.jsonl"))
    root = _text(workspace) or resolve_workspace()
    return str(Path(root) / "tmp" / "octopus" / "task-events.jsonl")


def load_delivery_events(pathname: str = "") -> list[dict[str, Any]]:
    path = Path(_text(pathname) or resolve_delivery_relay_path())
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def append_delivery_event(event_type: str, payload: dict[str, Any], relay_path: str = "") -> dict[str, Any]:
    event = {
        "schema_version": "octoclaw.delivery_relay.event/v1",
        "event": _text(event_type),
        **(payload if isinstance(payload, dict) else {}),
    }
    path = Path(_text(relay_path) or resolve_delivery_relay_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    return event


def _task_runner_job_id(task: dict[str, Any]) -> str:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    delegated = artifacts.get("delegated_materialization", {}) if isinstance(artifacts.get("delegated_materialization"), dict) else {}
    return (
        _text(task.get("runner_job_id"))
        or _text(task.get("job_id"))
        or _text(task.get("run_id"))
        or _text(delegated.get("runner_job_id"))
    )


def unresolved_pending_deliveries(
    events: list[dict[str, Any]],
    *,
    session_key: str = "",
    delivery_id: str = "",
) -> list[dict[str, Any]]:
    active: dict[str, dict[str, Any]] = {}
    for event in events:
        event_name = _text(event.get("event"))
        current_id = _text(event.get("deliveryId"))
        if not current_id:
            continue
        if delivery_id and current_id != delivery_id:
            continue
        if session_key and _text(event.get("sessionKey")) != session_key:
            continue
        if event_name == "delivery_pending":
            enriched = dict(event)
            enriched.setdefault("failedAttempts", 0)
            enriched.setdefault("lastFailedAt", "")
            enriched.setdefault("lastError", "")
            active[current_id] = enriched
            continue
        if event_name in TERMINAL_RELAY_EVENTS:
            active.pop(current_id, None)
            continue
        if event_name == "delivery_failed":
            pending = active.get(current_id)
            if not pending:
                continue
            pending["failedAttempts"] = int(pending.get("failedAttempts", 0) or 0) + 1
            pending["lastFailedAt"] = _text(event.get("at"))
            pending["lastError"] = _text(event.get("error"))
    return sorted(active.values(), key=lambda item: _text(item.get("at")))


def find_pending_delivery_for_task(
    events: list[dict[str, Any]],
    *,
    task: dict[str, Any] | None = None,
    task_id: str = "",
    runner_job_id: str = "",
    session_key: str = "",
) -> dict[str, Any] | None:
    task = task if isinstance(task, dict) else {}
    wanted_task_id = _text(task_id) or _text(task.get("id"))
    wanted_runner_job_id = _text(runner_job_id) or _task_runner_job_id(task)
    wanted_session_key = _text(session_key) or _text(task.get("session_key"))
    pending_items = unresolved_pending_deliveries(
        events,
        session_key=wanted_session_key,
    ) if wanted_session_key else unresolved_pending_deliveries(events)

    if wanted_task_id:
        for item in reversed(pending_items):
            if _text(item.get("taskId")) == wanted_task_id:
                return item
    if wanted_runner_job_id:
        for item in reversed(pending_items):
            if _text(item.get("runnerJobId")) == wanted_runner_job_id:
                return item
    if wanted_session_key and pending_items:
        return pending_items[-1]
    return None


def record_task_completion_delivery_result(
    task: dict[str, Any],
    result: dict[str, Any] | None,
    *,
    relay_path: str = "",
    source: str = "task_state_update",
) -> dict[str, Any]:
    normalized_result = result if isinstance(result, dict) else {}
    if normalized_result.get("skipped"):
        return {"recorded": False, "reason": "skipped"}
    events = load_delivery_events(relay_path)
    pending = find_pending_delivery_for_task(events, task=task)
    if not pending:
        return {"recorded": False, "reason": "no_pending_delivery"}
    task_id = _text(task.get("id")) or _text(pending.get("taskId"))
    runner_job_id = _task_runner_job_id(task) or _text(pending.get("runnerJobId"))
    event_type = "delivery_compensated" if normalized_result.get("ok") else "delivery_failed"
    payload = {
        "deliveryId": _text(pending.get("deliveryId")),
        "sessionKey": _text(task.get("session_key")) or _text(pending.get("sessionKey")),
        "taskId": task_id,
        "runnerJobId": runner_job_id,
        "source": source,
        "backend": _text(normalized_result.get("backend")),
        "messageId": _text(normalized_result.get("message_id") or normalized_result.get("messageId")),
        "action": _text(normalized_result.get("action")),
        "error": _text(normalized_result.get("error")),
        "summary": _text(task.get("user_safe_summary")) or _text(task.get("summary")) or _text(pending.get("summary")),
        "state": "completion_relay_sent" if normalized_result.get("ok") else "completion_relay_failed",
    }
    event = append_delivery_event(event_type, payload, relay_path=relay_path)
    append_task_event(
        task,
        "delivery_sent" if normalized_result.get("ok") else "delivery_failed",
        message=_text(task.get("user_safe_summary")) or _text(task.get("summary")) or _text(normalized_result.get("error")),
        extra={
            "delivery_id": _text(event.get("deliveryId")),
            "runner_job_id": runner_job_id,
            "message_id": _text(event.get("messageId")),
            "backend": _text(event.get("backend")),
            "error": _text(event.get("error")),
        },
        path=resolve_task_events_path(relay_path=relay_path),
    )
    return {"recorded": True, "event": event}
