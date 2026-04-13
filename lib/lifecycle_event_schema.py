"""Lifecycle event schema constants for OctoClaw task lifecycle."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

LIFECYCLE_EVENT_SCHEMA_VERSION = "octoclaw.lifecycle_event/v1"

LIFECYCLE_EVENT_KINDS = frozenset([
    "route_selected",
    "dispatch_started",
    "task_started",
    "task_running",
    "task_completed",
    "task_blocked",
    "source_blocked",
    "task_failed",
    "result_ready",
    "handoff_ready",
    "artifact_ready",
    "progress_checkpoint",
    "heartbeat",
    "current_step",
    "last_tool",
    "job_enqueued",
    "job_claimed",
    "job_completed",
    "job_failed",
    "job_timed_out",
    "materialization_succeeded",
    "materialization_failed",
    "native_sync_succeeded",
    "native_sync_failed",
    "dispatch_dedup_hit",
])

TERMINAL_TRANSITION_KINDS = frozenset([
    "task_completed",
    "task_blocked",
    "source_blocked",
    "task_failed",
    "job_completed",
    "job_failed",
    "job_timed_out",
])

NATIVE_SYNC_KINDS = frozenset([
    "task_completed",
    "task_failed",
])

PROGRESS_KINDS = frozenset([
    "progress_checkpoint",
    "heartbeat",
    "current_step",
    "last_tool",
])

RUNNER_JOB_KINDS = frozenset([
    "job_enqueued",
    "job_claimed",
    "job_completed",
    "job_failed",
    "job_timed_out",
])

MATERIALIZATION_KINDS = frozenset([
    "materialization_succeeded",
    "materialization_failed",
])

EVENT_IMPORTANCE: dict[str, str] = {
    "job_timed_out": "high",
    "task_failed": "high",
    "task_blocked": "high",
    "source_blocked": "high",
    "handoff_ready": "high",
    "materialization_failed": "high",
    "native_sync_failed": "high",
    "dispatch_dedup_hit": "high",
    "task_completed": "normal",
    "task_started": "normal",
    "task_running": "normal",
    "result_ready": "normal",
    "artifact_ready": "normal",
    "job_enqueued": "normal",
    "job_claimed": "normal",
    "job_completed": "normal",
    "materialization_succeeded": "normal",
    "native_sync_succeeded": "normal",
    "progress_checkpoint": "normal",
    "route_selected": "low",
    "dispatch_started": "low",
    "heartbeat": "low",
    "current_step": "low",
    "last_tool": "low",
}


def now_iso() -> str:
    """Return current UTC time in ISO format with timezone."""
    return datetime.now(timezone.utc).astimezone().isoformat()


def validate_lifecycle_event_kind(kind: str) -> bool:
    """Check if kind is a valid lifecycle event kind."""
    return kind in LIFECYCLE_EVENT_KINDS


def is_terminal_transition(kind: str) -> bool:
    """Check if kind represents a terminal state transition."""
    return kind in TERMINAL_TRANSITION_KINDS


def requires_native_sync(kind: str) -> bool:
    """Check if kind should trigger native-bound sync for finish/fail."""
    return kind in NATIVE_SYNC_KINDS


def is_progress_kind(kind: str) -> bool:
    """Check if kind is a progress-related event."""
    return kind in PROGRESS_KINDS


def event_importance(kind: str) -> str:
    """Return importance level for event kind (default 'normal')."""
    return EVENT_IMPORTANCE.get(kind, "normal")


def build_lifecycle_event_payload(task: dict[str, Any], kind: str, **kwargs: Any) -> dict[str, Any]:
    """Build a lifecycle event payload from a task dict and event kind.

    Args:
        task: Task dictionary containing task metadata.
        kind: Lifecycle event kind (must be in LIFECYCLE_EVENT_KINDS).
        **kwargs: Extra fields to merge into the payload.

    Returns:
        Dictionary with schema_version, time, kind, task_id, parent_id,
        session_key, route, worker_pool, status, lifecycle_state,
        outcome_state, handoff_state, plus any extra kwargs.

    Raises:
        ValueError: If kind is not in LIFECYCLE_EVENT_KINDS.
    """
    if kind not in LIFECYCLE_EVENT_KINDS:
        raise ValueError(f"Unknown lifecycle event kind: {kind}")

    raw_task = task if isinstance(task, dict) else {}
    payload = {
        "schema_version": LIFECYCLE_EVENT_SCHEMA_VERSION,
        "time": now_iso(),
        "kind": kind,
        "task_id": str(raw_task.get("id") or ""),
        "parent_id": str(raw_task.get("parent_id") or ""),
        "session_key": str(raw_task.get("session_key") or ""),
        "route": str(raw_task.get("route") or ""),
        "worker_pool": str(raw_task.get("worker_pool") or ""),
        "status": str(raw_task.get("status") or ""),
        "lifecycle_state": str(raw_task.get("lifecycle_state") or ""),
        "outcome_state": str(raw_task.get("outcome_state") or ""),
        "handoff_state": str(raw_task.get("handoff_state") or ""),
    }
    payload.update({k: v for k, v in kwargs.items() if v not in (None, "")})
    return payload