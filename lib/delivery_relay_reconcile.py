#!/usr/bin/env python3
"""Reconcile pending delivery relay entries against task-state and completion notifier."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

try:
    from notifier import send_task_completion_notification
    from runtime_task_record import task_state_model
except ModuleNotFoundError:  # pragma: no cover
    from lib.notifier import send_task_completion_notification
    from lib.runtime_task_record import task_state_model


TERMINAL_RELAY_EVENTS = {
    "delivery_observed",
    "delivery_compensated",
    "delivery_reconciled_delivered",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def load_jsonl(pathname: str) -> list[dict[str, Any]]:
    path = Path(pathname)
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


def load_tasks(pathname: str) -> list[dict[str, Any]]:
    path = Path(pathname)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    tasks = payload.get("tasks", []) if isinstance(payload, dict) else []
    return [item for item in tasks if isinstance(item, dict)]


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
            active[current_id] = dict(event)
            continue
        if event_name in TERMINAL_RELAY_EVENTS:
            active.pop(current_id, None)
    return sorted(active.values(), key=lambda item: _text(item.get("at")))


def _task_runner_job_id(task: dict[str, Any]) -> str:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    delegated = artifacts.get("delegated_materialization", {}) if isinstance(artifacts.get("delegated_materialization"), dict) else {}
    return (
        _text(task.get("runner_job_id"))
        or _text(task.get("job_id"))
        or _text(task.get("run_id"))
        or _text(delegated.get("runner_job_id"))
    )


def find_task_for_delivery(tasks: list[dict[str, Any]], pending: dict[str, Any]) -> dict[str, Any] | None:
    task_id = _text(pending.get("taskId"))
    runner_job_id = _text(pending.get("runnerJobId"))
    session_key = _text(pending.get("sessionKey"))

    if task_id:
        for task in tasks:
            if _text(task.get("id")) == task_id:
                return task

    if runner_job_id:
        for task in tasks:
            if _task_runner_job_id(task) == runner_job_id:
                return task

    if session_key:
        candidates = [task for task in tasks if _text(task.get("session_key")) == session_key]
        if candidates:
            candidates.sort(key=lambda task: _text(task.get("updated_at")) or _text(task.get("completed_at")) or _text(task.get("created_at")))
            return candidates[-1]
    return None


def reconcile_pending_delivery(
    pending: dict[str, Any],
    *,
    tasks: list[dict[str, Any]],
    backend: str = "auto",
) -> dict[str, Any]:
    delivery_id = _text(pending.get("deliveryId"))
    task = find_task_for_delivery(tasks, pending)
    if not task:
      return {
          "deliveryId": delivery_id,
          "status": "task_missing",
          "taskId": _text(pending.get("taskId")),
          "runnerJobId": _text(pending.get("runnerJobId")),
      }

    state = task_state_model(task)
    handoff_state = _text(state.get("handoff_state"))
    lifecycle_state = _text(state.get("lifecycle_state"))
    outcome_state = _text(state.get("outcome_state"))
    result = {
        "deliveryId": delivery_id,
        "taskId": _text(task.get("id")),
        "runnerJobId": _task_runner_job_id(task),
        "handoffState": handoff_state,
        "lifecycleState": lifecycle_state,
        "outcomeState": outcome_state,
        "summary": _text(state.get("user_safe_summary")) or _text(task.get("summary")),
    }
    if handoff_state == "delivered":
        result["status"] = "already_delivered"
        return result
    if handoff_state != "user_safe_ready":
        result["status"] = "task_not_ready"
        return result

    notify_result = send_task_completion_notification(task, backend=backend)
    result["notifyResult"] = notify_result if isinstance(notify_result, dict) else {}
    if isinstance(notify_result, dict) and notify_result.get("ok"):
        result["status"] = "compensated"
        result["messageId"] = _text(notify_result.get("message_id") or notify_result.get("messageId"))
    else:
        result["status"] = "send_failed"
        result["error"] = _text((notify_result or {}).get("error")) or "completion relay send failed"
    return result


def reconcile_pending_deliveries(
    *,
    relay_path: str,
    task_state_path: str,
    session_key: str = "",
    delivery_id: str = "",
    backend: str = "auto",
) -> dict[str, Any]:
    events = load_jsonl(relay_path)
    pending_items = unresolved_pending_deliveries(events, session_key=session_key, delivery_id=delivery_id)
    tasks = load_tasks(task_state_path)
    items = [
        reconcile_pending_delivery(item, tasks=tasks, backend=backend)
        for item in pending_items
    ]
    return {
        "ok": True,
        "relay_path": relay_path,
        "task_state_path": task_state_path,
        "session_key": session_key,
        "delivery_id": delivery_id,
        "pending_count": len(pending_items),
        "items": items,
    }


def main() -> None:
    fixture = _text(os.environ.get("OCTOCLAW_DELIVERY_RELAY_RESULT_JSON"))
    if fixture:
        try:
            payload = json.loads(fixture)
        except json.JSONDecodeError:
            payload = {"ok": False, "error": "invalid OCTOCLAW_DELIVERY_RELAY_RESULT_JSON"}
        print(json.dumps(payload, ensure_ascii=False))
        return
    parser = argparse.ArgumentParser(description="Reconcile OctoClaw delivery relay entries")
    parser.add_argument("--relay-path", required=True)
    parser.add_argument("--task-state", required=True)
    parser.add_argument("--session-key", default="")
    parser.add_argument("--delivery-id", default="")
    parser.add_argument("--backend", default="auto")
    args = parser.parse_args()
    payload = reconcile_pending_deliveries(
        relay_path=args.relay_path,
        task_state_path=args.task_state,
        session_key=args.session_key,
        delivery_id=args.delivery_id,
        backend=args.backend,
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
