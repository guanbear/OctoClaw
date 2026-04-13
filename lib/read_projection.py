#!/usr/bin/env python3
"""Unified read projection for OctoClaw task state.

Provides a SINGLE abstraction for reading task state. All read surfaces
(status_render, task_display, task_display_cli, notifier, runtime_snapshot,
etc.) should eventually call this instead of directly reading task-state.json.
"""

from __future__ import annotations

import fcntl
import json
import os
from typing import Any

try:
    from runtime_task_record import normalize_task_record, task_state_model
except ModuleNotFoundError:  # pragma: no cover
    from lib.runtime_task_record import normalize_task_record, task_state_model

try:
    from octopus_config import TASK_STATE_FILE, RUNNER_QUEUE_FILE
except ModuleNotFoundError:  # pragma: no cover
    from lib.octopus_config import TASK_STATE_FILE, RUNNER_QUEUE_FILE

try:
    from runner_queue import queue_status_by_capacity_group  # type: ignore[attr-defined]
except (ModuleNotFoundError, ImportError):  # pragma: no cover
    queue_status_by_capacity_group = None  # type: ignore[assignment,misc]

READ_PROJECTION_SCHEMA_VERSION = "octoclaw.read_projection/v1"

TERMINAL_LIFECYCLE_STATES = {"finished", "cancelled"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _task_state_path(workspace: str) -> str:
    if workspace:
        return os.path.join(workspace, "tmp/octopus/task-state.json")
    return TASK_STATE_FILE


def _runner_queue_path(workspace: str) -> str:
    if workspace:
        return os.path.join(workspace, "tmp/octopus/runner-queue.json")
    return RUNNER_QUEUE_FILE


def _load_task_state(path: str) -> dict[str, Any]:
    """Load task-state.json with shared lock. Returns safe default on error."""
    try:
        with open(path, "r", encoding="utf-8") as fp:
            fcntl.flock(fp, fcntl.LOCK_SH)
            try:
                raw = fp.read()
            finally:
                fcntl.flock(fp, fcntl.LOCK_UN)
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {"tasks": [], "updated_at": ""}


def _is_terminal(task: dict[str, Any]) -> bool:
    """Return True if the task's lifecycle_state is terminal."""
    state = task_state_model(task)
    return state.get("lifecycle_state", "") in TERMINAL_LIFECYCLE_STATES


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def read_task(task_id: str, workspace: str = "") -> dict[str, Any] | None:
    """Read a single task by id. Returns normalized record or None."""
    path = _task_state_path(workspace)
    data = _load_task_state(path)
    tasks = data.get("tasks", [])
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if str(task.get("id", "")).strip() == str(task_id).strip():
            return normalize_task_record(task)
    return None


def read_tasks(filters: dict[str, Any] | None = None, workspace: str = "") -> list[dict[str, Any]]:
    """Read all tasks with optional filters. Returns list of normalized records."""
    path = _task_state_path(workspace)
    data = _load_task_state(path)
    raw_tasks = data.get("tasks", [])
    results: list[dict[str, Any]] = []
    for task in raw_tasks:
        if not isinstance(task, dict):
            continue
        normalized = normalize_task_record(task)
        if normalized and _matches_filters(normalized, filters or {}):
            results.append(normalized)
    return results


def read_active_tasks(
    session_key: str | None = None,
    route: str | None = None,
    capacity_group: str | None = None,
    workspace: str = "",
) -> list[dict[str, Any]]:
    """Convenience wrapper: filter for non-terminal tasks with optional params."""
    path = _task_state_path(workspace)
    data = _load_task_state(path)
    raw_tasks = data.get("tasks", [])
    results: list[dict[str, Any]] = []
    for task in raw_tasks:
        if not isinstance(task, dict):
            continue
        normalized = normalize_task_record(task)
        if not normalized:
            continue
        if _is_terminal(normalized):
            continue
        if session_key is not None and str(normalized.get("session_key", "")) != session_key:
            continue
        if route is not None and str(normalized.get("route", "")) != route:
            continue
        if capacity_group is not None and str(normalized.get("capacity_group", "")) != capacity_group:
            continue
        results.append(normalized)
    return results


def read_task_with_lineage(task_id: str, workspace: str = "") -> dict[str, Any]:
    """Read task + children + parent. Returns dict with task/children/parent."""
    path = _task_state_path(workspace)
    data = _load_task_state(path)
    raw_tasks = data.get("tasks", [])

    task_map: dict[str, dict[str, Any]] = {}
    for task in raw_tasks:
        if isinstance(task, dict):
            tid = str(task.get("id", "")).strip()
            if tid:
                task_map[tid] = task

    target_raw = task_map.get(str(task_id).strip())
    if target_raw is None:
        return {"task": None, "children": [], "parent": None}

    target = normalize_task_record(target_raw)

    children: list[dict[str, Any]] = []
    for tid, raw in task_map.items():
        parent_id = str(raw.get("parent_id", "")).strip()
        if parent_id == str(task_id).strip():
            children.append(normalize_task_record(raw))

    parent: dict[str, Any] | None = None
    parent_id = str(target_raw.get("parent_id", "")).strip()
    if parent_id and parent_id in task_map:
        parent = normalize_task_record(task_map[parent_id])

    return {"task": target, "children": children, "parent": parent}


def read_queue_snapshot(workspace: str = "") -> dict[str, Any]:
    """Read runner-queue.json with shared lock. Returns queue summary."""
    path = _runner_queue_path(workspace)
    try:
        with open(path, "r", encoding="utf-8") as fp:
            fcntl.flock(fp, fcntl.LOCK_SH)
            try:
                raw = fp.read()
            finally:
                fcntl.flock(fp, fcntl.LOCK_UN)
        data = json.loads(raw)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        data = None

    if not isinstance(data, dict):
        data = {"jobs": [], "updated_at": ""}

    jobs = data.get("jobs", [])
    if not isinstance(jobs, list):
        jobs = []

    queued = len([j for j in jobs if isinstance(j, dict) and j.get("status") == "queued"])
    running = len([j for j in jobs if isinstance(j, dict) and j.get("status") == "running"])
    done = len([j for j in jobs if isinstance(j, dict) and j.get("status") == "done"])
    failed = len([j for j in jobs if isinstance(j, dict) and j.get("status") == "failed"])

    result: dict[str, Any] = {
        "queued": queued,
        "running": running,
        "done": done,
        "failed": failed,
        "total": len(jobs),
    }

    if queue_status_by_capacity_group is not None:
        try:
            result["capacity_groups"] = queue_status_by_capacity_group(jobs)
        except Exception:  # pragma: no cover
            result["capacity_groups"] = {}
    else:
        result["capacity_groups"] = _capacity_groups_from_jobs(jobs)

    return result


# ---------------------------------------------------------------------------
# Internal filter matching
# ---------------------------------------------------------------------------

def _matches_filters(task: dict[str, Any], filters: dict[str, Any]) -> bool:
    """Check if a normalized task record matches all filter criteria."""
    if not filters:
        return True

    simple_fields = {
        "status", "route", "session_key", "dispatch_key",
        "lane_key", "capacity_group", "parent_id", "task_kind",
    }
    for field in simple_fields:
        if field in filters:
            if str(task.get(field, "")) != str(filters[field]):
                return False

    if "lifecycle_state" in filters:
        state = task_state_model(task)
        if state.get("lifecycle_state", "") != str(filters["lifecycle_state"]):
            return False

    if "outcome_state" in filters:
        state = task_state_model(task)
        if state.get("outcome_state", "") != str(filters["outcome_state"]):
            return False

    return True


def _capacity_groups_from_jobs(jobs: list[Any]) -> dict[str, dict[str, int]]:
    """Compute per-capacity-group status counts from jobs list."""
    groups: dict[str, dict[str, int]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        group = str(job.get("capacity_group", "") or job.get("model_band", "") or "default")
        status = str(job.get("status", ""))
        bucket = groups.setdefault(group, {"queued": 0, "running": 0, "done": 0, "failed": 0})
        if status in bucket:
            bucket[status] += 1
    return groups
