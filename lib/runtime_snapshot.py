#!/usr/bin/env python3
"""Shared read-only runtime snapshot helpers for OctoClaw."""

from __future__ import annotations

import shutil
import subprocess
from collections import Counter
from datetime import datetime, timezone
from typing import Any

try:
    from octopus_config import (
        RUNNER_HEALTH_FILE,
        RUNNER_QUEUE_FILE,
        TASK_STATE_FILE,
        WORKSPACE,
        load_json,
        load_octopus_config,
        resolve_runner_mode,
        workbench_config,
    )
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import (
        RUNNER_HEALTH_FILE,
        RUNNER_QUEUE_FILE,
        TASK_STATE_FILE,
        WORKSPACE,
        load_json,
        load_octopus_config,
        resolve_runner_mode,
        workbench_config,
    )

try:
    from task_events import load_task_events
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_events import load_task_events


RUNNER_STALE_SECONDS = 120
FINAL_STATUSES = {"done", "completed", "failed", "blocked", "deferred"}
EVENT_STATUS_PRIORITY = (
    ("failed", "failed"),
    ("task_failed", "failed"),
    ("source_blocked", "blocked"),
    ("task_blocked", "blocked"),
    ("task_completed", "done"),
    ("task_running", "running"),
    ("task_started", "running"),
)


def normalize_runner_mode(value: str) -> str:
    text = str(value or "").strip().lower()
    if text in {"ondemand", "on_demand"}:
        return "ondemand"
    if text in {"daemon", "resident"}:
        return "daemon"
    return ""


def default_runner_execution_mode(value: str = "") -> str:
    return normalize_runner_mode(value) or "daemon"


def probe_tmux_session(session_name: str, *, runner_window_name: str = "runner") -> dict[str, Any]:
    session = str(session_name or "").strip()
    window = str(runner_window_name or "runner").strip() or "runner"
    if not session:
        return {"required": False, "available": False, "healthy": False, "reason": "not_configured"}
    tmux_bin = shutil.which("tmux")
    if not tmux_bin:
        return {"required": True, "available": False, "healthy": False, "reason": "tmux_missing", "session_name": session, "runner_window_name": window}
    has_session = subprocess.run(
        [tmux_bin, "has-session", "-t", session],
        capture_output=True,
        text=True,
        check=False,
    )
    if has_session.returncode != 0:
        return {
            "required": True,
            "available": True,
            "healthy": False,
            "reason": "tmux_session_missing",
            "session_name": session,
            "runner_window_name": window,
        }
    windows = subprocess.run(
        [tmux_bin, "list-windows", "-t", session, "-F", "#{window_name}"],
        capture_output=True,
        text=True,
        check=False,
    )
    window_names = [line.strip() for line in str(windows.stdout or "").splitlines() if line.strip()]
    window_present = window in window_names
    return {
        "required": True,
        "available": True,
        "healthy": window_present,
        "reason": "ok" if window_present else "tmux_runner_window_missing",
        "session_name": session,
        "runner_window_name": window,
        "windows": window_names[:20],
    }


def parse_iso(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def load_runtime_tasks() -> list[dict[str, Any]]:
    raw = load_json(TASK_STATE_FILE)
    if not isinstance(raw, dict):
        return []
    tasks = raw.get("tasks", [])
    if not isinstance(tasks, list):
        return []
    filtered = [dict(task) for task in tasks if isinstance(task, dict) and task.get("source") in {"octoclaw", "octopus"}]
    queue_raw = load_json(RUNNER_QUEUE_FILE)
    jobs = queue_raw.get("jobs", []) if isinstance(queue_raw, dict) else []
    queue_by_id = {
        str(job.get("id")): job
        for job in jobs
        if isinstance(job, dict) and str(job.get("id", "")).startswith("runner-")
    }
    for task in filtered:
        job = queue_by_id.get(str(task.get("id", "")))
        if not job:
            continue
        job_status = str(job.get("status", "") or "")
        if job_status in {"done", "failed"}:
            task["status"] = "done" if job_status == "done" else "failed"
            task["summary"] = str(job.get("summary") or task.get("summary") or "")
            if job.get("started_at"):
                task["started_at"] = job.get("started_at")
            if job.get("finished_at"):
                task["completed_at"] = job.get("finished_at")
            if job.get("model"):
                task["model"] = job.get("model")
            if job.get("task_description"):
                task["task_description"] = job.get("task_description")
    return filtered


def load_recent_task_events(*, limit: int = 800) -> list[dict[str, Any]]:
    return [event for event in load_task_events(limit=max(0, int(limit or 0))) if isinstance(event, dict)]


def _event_index(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    indexed: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        task_id = str(event.get("task_id", "") or "").strip()
        if not task_id:
            continue
        indexed.setdefault(task_id, []).append(event)
    return indexed


def _event_times(events: list[dict[str, Any]], kind: str) -> str:
    for event in reversed(events):
        if str(event.get("kind", "") or "").strip().lower() == kind:
            return str(event.get("time", "") or "").strip()
    return ""


def summarize_runtime_task_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    kind_counts: Counter[str] = Counter()
    latest_kind = ""
    latest_time = ""
    latest_message = ""
    for event in events:
        kind = str(event.get("kind", "") or "").strip().lower()
        if not kind:
            continue
        kind_counts[kind] += 1
        latest_kind = kind
        latest_time = str(event.get("time", "") or "").strip()
        latest_message = str(event.get("message", "") or "").strip()
    return {
        "kind_counts": dict(kind_counts),
        "latest_kind": latest_kind,
        "latest_time": latest_time,
        "latest_message": latest_message,
        "task_started_at": _event_times(events, "task_started"),
        "task_running_at": _event_times(events, "task_running"),
        "task_completed_at": _event_times(events, "task_completed"),
        "result_ready_at": _event_times(events, "result_ready"),
        "handoff_ready_at": _event_times(events, "handoff_ready"),
        "delivered_at": _event_times(events, "user_notified"),
    }


def derive_task_status_from_events(task: dict[str, Any], event_summary: dict[str, Any]) -> str:
    projection_status = str(task.get("status", "") or "").strip().lower()
    if projection_status in FINAL_STATUSES:
        return projection_status
    counts = event_summary.get("kind_counts", {}) if isinstance(event_summary.get("kind_counts", {}), dict) else {}
    for kind, derived_status in EVENT_STATUS_PRIORITY:
        if int(counts.get(kind, 0) or 0) > 0:
            return derived_status
    return projection_status


def annotate_tasks_with_event_facts(
    tasks: list[dict[str, Any]],
    *,
    task_events: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    indexed = _event_index(task_events or [])
    annotated: list[dict[str, Any]] = []
    for raw_task in tasks:
        if not isinstance(raw_task, dict):
            continue
        task = dict(raw_task)
        task_id = str(task.get("id", "") or "").strip()
        events = indexed.get(task_id, [])
        event_summary = summarize_runtime_task_events(events)
        projection_status = str(task.get("status", "") or "").strip().lower()
        read_model_status = derive_task_status_from_events(task, event_summary)
        task["projection_status"] = projection_status
        task["read_model_status"] = read_model_status
        task["status_source"] = "event_read_model" if read_model_status and read_model_status != projection_status else "projection"
        if read_model_status:
            task["status"] = read_model_status
        latest_kind = str(event_summary.get("latest_kind", "") or "").strip()
        latest_time = str(event_summary.get("latest_time", "") or "").strip()
        if latest_kind:
            task["latest_event_kind"] = latest_kind
        if latest_time:
            task["latest_event_at"] = latest_time
        if not task.get("result_ready_at") and event_summary.get("result_ready_at"):
            task["result_ready_at"] = event_summary["result_ready_at"]
        if not task.get("handoff_ready_at") and event_summary.get("handoff_ready_at"):
            task["handoff_ready_at"] = event_summary["handoff_ready_at"]
        if not task.get("delivered_at") and event_summary.get("delivered_at"):
            task["delivered_at"] = event_summary["delivered_at"]
        annotated.append(task)
    return annotated


def load_runner_queue_counts() -> dict[str, int]:
    raw = load_json(RUNNER_QUEUE_FILE)
    jobs = raw.get("jobs", []) if isinstance(raw, dict) else []
    counter: Counter[str] = Counter()
    for job in jobs:
        if not isinstance(job, dict):
            continue
        status = str(job.get("status", "") or "").strip().lower()
        if status:
            counter[status] += 1
    return {
        "queued": int(counter.get("queued", 0) or 0),
        "running": int(counter.get("running", 0) or 0),
        "done": int(counter.get("done", 0) or 0),
        "failed": int(counter.get("failed", 0) or 0),
        "total": sum(counter.values()),
    }


def load_runner_health(*, stale_after_seconds: int = RUNNER_STALE_SECONDS) -> dict[str, Any]:
    health = load_json(RUNNER_HEALTH_FILE)
    if not isinstance(health, dict):
        return {"present": False, "healthy": False, "reason": "missing"}
    runtime_cfg = load_octopus_config().get("runtime_policy", {})
    runtime_cfg = runtime_cfg if isinstance(runtime_cfg, dict) else {}
    runner_pool = runtime_cfg.get("runner_pool", {})
    runner_pool = runner_pool if isinstance(runner_pool, dict) else {}
    unhealthy_after_failures = max(0, int(runner_pool.get("worker_unhealthy_after_failures", 0) or 0))
    worker_id = str(health.get("worker_id", "") or "").strip()
    if not worker_id:
        return {"present": False, "healthy": False, "reason": "missing"}
    failure_streak = max(0, int(health.get("failure_streak", 0) or 0))
    last = parse_iso(str(health.get("last_heartbeat_at", "") or ""))
    if last is None:
        return {
            **health,
            "present": True,
            "healthy": False,
            "reason": "missing_heartbeat",
            "worker_id": worker_id,
            "health": health,
        }
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_seconds = max(0, int((datetime.now(timezone.utc) - last.astimezone(timezone.utc)).total_seconds()))
    healthy = age_seconds <= stale_after_seconds
    reason = "ok" if healthy else str(health.get("reason") or "stale")
    if healthy and unhealthy_after_failures > 0 and failure_streak >= unhealthy_after_failures:
        healthy = False
        reason = "failure_streak"
    return {
        **health,
        "present": True,
        "healthy": healthy,
        "reason": reason,
        "age_seconds": age_seconds,
        "worker_id": worker_id,
        "failure_streak": failure_streak,
        "last_job_status": str(health.get("last_job_status", "") or "").strip(),
        "last_job_id": str(health.get("last_job_id", "") or "").strip(),
        "health": health,
    }


def build_runtime_snapshot(
    *,
    workspace: str = WORKSPACE,
    tasks: list[dict[str, Any]] | None = None,
    runner_health: dict[str, Any] | None = None,
    runner_execution_mode: str = "",
    queue_counts: dict[str, int] | None = None,
    task_events: list[dict[str, Any]] | None = None,
    changes: dict[str, Any] | None = None,
    recovered_task_ids: list[str] | None = None,
    heartbeat_reassigned_task_ids: list[str] | None = None,
) -> dict[str, Any]:
    runtime_tasks = annotate_tasks_with_event_facts(
        [task for task in (tasks or []) if isinstance(task, dict)],
        task_events=task_events if task_events is not None else load_recent_task_events(),
    )
    counts_by_status = Counter(str(task.get("status", "") or "").strip().lower() for task in runtime_tasks)
    active_tasks = (
        int(counts_by_status.get("queued", 0) or 0)
        + int(counts_by_status.get("running", 0) or 0)
        + int(counts_by_status.get("dispatched", 0) or 0)
        + int(counts_by_status.get("pending_confirm", 0) or 0)
    )
    final_tasks = (
        int(counts_by_status.get("done", 0) or 0)
        + int(counts_by_status.get("completed", 0) or 0)
        + int(counts_by_status.get("failed", 0) or 0)
        + int(counts_by_status.get("blocked", 0) or 0)
        + int(counts_by_status.get("deferred", 0) or 0)
    )
    runner = dict(runner_health or {})
    mode = default_runner_execution_mode(runner_execution_mode)
    resident_state = "healthy"
    runner_state = "healthy"
    if not runner.get("present", False):
        resident_state = str(runner.get("reason", "missing") or "missing")
        runner_state = "on-demand" if mode == "ondemand" else resident_state
    elif not runner.get("healthy", False):
        resident_state = str(runner.get("reason", "stale") or "stale")
        runner_state = resident_state
    fallback_truth = {
        "mode": "ondemand",
        "eligible": bool(mode == "ondemand" or runner_state != "healthy"),
        "state": "available" if mode == "ondemand" or runner_state != "healthy" else "idle",
    }
    workbench = workbench_config(load_octopus_config())
    workbench_mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
    workbench_session = str(workbench.get("tmux_session_name", "") or "").strip()
    workbench_runner_window = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    optional_workbench = bool(workbench_mode == "tmux" and workbench_session)
    tmux_status = probe_tmux_session(workbench_session, runner_window_name=workbench_runner_window) if optional_workbench else {
        "required": False,
        "available": False,
        "healthy": False,
        "reason": "not_configured",
    }
    return {
        "observed_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "workspace": workspace,
        "runner_health": runner,
        "runner_execution_mode": mode,
        "runner": {
            "state": runner_state,
            "present": bool(runner.get("present", False)),
            "healthy": bool(runner.get("healthy", False)),
            "age_seconds": int(runner.get("age_seconds", 0) or 0) if runner.get("age_seconds") is not None else None,
            "worker_id": str(runner.get("worker_id", "") or "").strip(),
            "job_id": str(runner.get("job_id", "") or "").strip(),
            "reason": str(runner.get("reason", "") or "").strip(),
            "failure_streak": int(runner.get("failure_streak", 0) or 0),
            "last_job_status": str(runner.get("last_job_status", "") or "").strip(),
            "mode": mode,
            "resident_mode": "daemon",
            "resident_state": resident_state,
            "fallback_truth": fallback_truth,
            "recovery_suggested": bool(mode != "ondemand" and runner_state != "healthy"),
        },
        "counts": {
            "total": len(runtime_tasks),
            "queued": int(counts_by_status.get("queued", 0) or 0),
            "running": int(counts_by_status.get("running", 0) or 0) + int(counts_by_status.get("dispatched", 0) or 0),
            "pending": int(counts_by_status.get("pending_confirm", 0) or 0),
            "done": int(counts_by_status.get("done", 0) or 0) + int(counts_by_status.get("completed", 0) or 0),
            "failed": int(counts_by_status.get("failed", 0) or 0)
            + int(counts_by_status.get("blocked", 0) or 0)
            + int(counts_by_status.get("deferred", 0) or 0),
            "active": active_tasks,
            "final": final_tasks,
        },
        "tasks": runtime_tasks,
        "queue_counts": dict(queue_counts or {}),
        "changes": {
            "progress_hydrated": int((changes or {}).get("progress_hydrated", 0) or 0),
            "results_hydrated": int((changes or {}).get("results_hydrated", 0) or 0),
            "heartbeat_reassigned": int((changes or {}).get("heartbeat_reassigned", 0) or 0),
            "dead_agent_recovered": int((changes or {}).get("dead_agent_recovered", 0) or 0),
        },
        "recovered_task_ids": [str(item).strip() for item in (recovered_task_ids or []) if str(item).strip()],
        "heartbeat_reassigned_task_ids": [
            str(item).strip() for item in (heartbeat_reassigned_task_ids or []) if str(item).strip()
        ],
        "workbench": {
            "role": "optional_workbench",
            "optional_backend": optional_workbench,
            "supervisor_mode": workbench_mode,
            "tmux_session_name": workbench_session if optional_workbench else "",
            "tmux_runner_window_name": workbench_runner_window if optional_workbench else "",
            "tmux_required": bool(tmux_status.get("required", False)),
            "tmux_available": bool(tmux_status.get("available", False)),
            "tmux_healthy": bool(tmux_status.get("healthy", False)),
            "tmux_reason": str(tmux_status.get("reason", "") or "").strip(),
            "tmux_windows": list(tmux_status.get("windows", []) or [])[:20],
        },
    }


def observe_runtime_snapshot(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    tasks = load_runtime_tasks()
    runner_health = load_runner_health()
    runner_execution_mode = default_runner_execution_mode(resolve_runner_mode())
    queue_counts = load_runner_queue_counts()
    task_events = load_recent_task_events()
    return build_runtime_snapshot(
        workspace=workspace,
        tasks=tasks,
        runner_health=runner_health,
        runner_execution_mode=runner_execution_mode,
        queue_counts=queue_counts,
        task_events=task_events,
    )
