#!/usr/bin/env python3
"""Shared read-only runtime snapshot helpers for OctoClaw."""

from __future__ import annotations

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


RUNNER_STALE_SECONDS = 120


def normalize_runner_mode(value: str) -> str:
    text = str(value or "").strip().lower()
    if text in {"ondemand", "on_demand"}:
        return "ondemand"
    if text == "daemon":
        return "daemon"
    return ""


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
    worker_id = str(health.get("worker_id", "") or "").strip()
    if not worker_id:
        return {"present": False, "healthy": False, "reason": "missing"}
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
    return {
        **health,
        "present": True,
        "healthy": healthy,
        "reason": "ok" if healthy else str(health.get("reason") or "stale"),
        "age_seconds": age_seconds,
        "worker_id": worker_id,
        "health": health,
    }


def build_runtime_snapshot(
    *,
    workspace: str = WORKSPACE,
    tasks: list[dict[str, Any]] | None = None,
    runner_health: dict[str, Any] | None = None,
    runner_execution_mode: str = "",
    queue_counts: dict[str, int] | None = None,
    changes: dict[str, Any] | None = None,
    recovered_task_ids: list[str] | None = None,
    heartbeat_reassigned_task_ids: list[str] | None = None,
) -> dict[str, Any]:
    runtime_tasks = [task for task in (tasks or []) if isinstance(task, dict)]
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
    mode = normalize_runner_mode(runner_execution_mode) or ("daemon" if runner.get("present", False) else "ondemand")
    runner_state = "healthy"
    if not runner.get("present", False):
        runner_state = "on-demand" if mode == "ondemand" else str(runner.get("reason", "missing") or "missing")
    elif not runner.get("healthy", False):
        runner_state = str(runner.get("reason", "stale") or "stale")
    workbench = workbench_config(load_octopus_config())
    workbench_mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
    workbench_session = str(workbench.get("tmux_session_name", "") or "").strip()
    optional_workbench = bool(workbench_mode == "tmux" and workbench_session)
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
            "mode": mode,
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
        },
    }


def observe_runtime_snapshot(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    tasks = load_runtime_tasks()
    runner_health = load_runner_health()
    runner_execution_mode = normalize_runner_mode(resolve_runner_mode()) or "ondemand"
    queue_counts = load_runner_queue_counts()
    return build_runtime_snapshot(
        workspace=workspace,
        tasks=tasks,
        runner_health=runner_health,
        runner_execution_mode=runner_execution_mode,
        queue_counts=queue_counts,
    )
