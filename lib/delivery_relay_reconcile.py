#!/usr/bin/env python3
"""Reconcile pending delivery relay entries against task-state and completion notifier."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from delivery_relay import load_delivery_events, unresolved_pending_deliveries
    from notifier import send_task_completion_notification
    from runtime_task_record import task_state_model
except ModuleNotFoundError:  # pragma: no cover
    from lib.delivery_relay import load_delivery_events, unresolved_pending_deliveries
    from lib.notifier import send_task_completion_notification
    from lib.runtime_task_record import task_state_model


def _text(value: Any) -> str:
    return str(value or "").strip()

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


def _parse_iso(value: Any) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


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
    retry_cooldown_seconds: int = 0,
    now: datetime | None = None,
) -> dict[str, Any]:
    delivery_id = _text(pending.get("deliveryId"))
    failed_attempts = int(pending.get("failedAttempts", 0) or 0)
    last_failed_at = _text(pending.get("lastFailedAt"))
    task = find_task_for_delivery(tasks, pending)
    if not task:
      return {
          "deliveryId": delivery_id,
          "status": "task_missing",
          "taskId": _text(pending.get("taskId")),
          "runnerJobId": _text(pending.get("runnerJobId")),
          "failedAttempts": failed_attempts,
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
        "failedAttempts": failed_attempts,
    }
    if handoff_state == "delivered":
        result["status"] = "already_delivered"
        return result
    if handoff_state != "user_safe_ready":
        result["status"] = "task_not_ready"
        return result

    if retry_cooldown_seconds > 0 and last_failed_at:
        failed_at = _parse_iso(last_failed_at)
        current_time = now or datetime.now(timezone.utc)
        if failed_at and current_time < failed_at + timedelta(seconds=retry_cooldown_seconds):
            retry_after = failed_at + timedelta(seconds=retry_cooldown_seconds)
            result["status"] = "retry_deferred"
            result["retryAfter"] = retry_after.astimezone().isoformat()
            result["lastFailedAt"] = last_failed_at
            return result

    notify_result = send_task_completion_notification(task, backend=backend)
    result["notifyResult"] = notify_result if isinstance(notify_result, dict) else {}
    if isinstance(notify_result, dict) and notify_result.get("ok"):
        result["status"] = "compensated"
        result["messageId"] = _text(notify_result.get("message_id") or notify_result.get("messageId"))
    else:
        result["status"] = "send_failed"
        result["error"] = _text((notify_result or {}).get("error")) or "completion relay send failed"
        result["failedAttempts"] = failed_attempts + 1
    return result


def reconcile_pending_deliveries(
    *,
    relay_path: str,
    task_state_path: str,
    session_key: str = "",
    delivery_id: str = "",
    backend: str = "auto",
    retry_cooldown_seconds: int = 30,
) -> dict[str, Any]:
    events = load_delivery_events(relay_path)
    pending_items = unresolved_pending_deliveries(events, session_key=session_key, delivery_id=delivery_id)
    tasks = load_tasks(task_state_path)
    items = [
        reconcile_pending_delivery(
            item,
            tasks=tasks,
            backend=backend,
            retry_cooldown_seconds=retry_cooldown_seconds,
        )
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
    parser.add_argument("--retry-cooldown-seconds", type=int, default=30)
    args = parser.parse_args()
    payload = reconcile_pending_deliveries(
        relay_path=args.relay_path,
        task_state_path=args.task_state,
        session_key=args.session_key,
        delivery_id=args.delivery_id,
        backend=args.backend,
        retry_cooldown_seconds=int(args.retry_cooldown_seconds or 0),
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
