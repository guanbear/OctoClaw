#!/usr/bin/env python3
"""Unified completion relay for OctoClaw — single entry point for all task completions."""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any

from completion_state_machine import validate_transition
from failure_taxonomy import default_handoff_state, default_outcome_state

try:
    from task_events import append_task_event
except ModuleNotFoundError:
    append_task_event = None  # type: ignore[assignment]

try:
    from openclaw_taskflow_adapter import sync_terminal_transition
except ModuleNotFoundError:
    sync_terminal_transition = None  # type: ignore[assignment]

COMPLETION_RELAY_SCHEMA_VERSION = "octoclaw.completion_relay/v1"


def _load_task_for_native_sync(task_id: str, workspace: str = "") -> dict | None:
    try:
        import json as _json, os as _os, fcntl
        state_file = _os.path.join(workspace, "tmp", "octopus", "task-state.json") if workspace else ""
        if not state_file or not _os.path.isfile(state_file):
            return None
        with open(state_file, "r") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            raw = f.read()
            fcntl.flock(f, fcntl.LOCK_UN)
        data = _json.loads(raw)
        for t in data.get("tasks", []):
            if isinstance(t, dict) and str(t.get("id", "") or "") == task_id:
                return t
    except Exception:
        pass
    return None


def _text(value: Any) -> str:
    return str(value or "").strip()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def build_completion_payload(
    task_id: str,
    status: str,
    summary: str = "",
    report_path: str = "",
    failure_type: str = "",
    **kwargs: Any,
) -> dict[str, Any]:
    """Build a completion payload dict with all required fields."""
    ft = _text(failure_type) or ("failed" if status == "failed" else "")
    outcome_state = default_outcome_state(ft) if ft else (
        "done" if status == "done" else
        "blocked" if status == "blocked" else
        "failed"
    )
    handoff_state = default_handoff_state(ft) if ft else (
        "internal_only" if status == "failed" else
        "none"
    )
    return {
        "schema_version": COMPLETION_RELAY_SCHEMA_VERSION,
        "task_id": _text(task_id),
        "status": _text(status),
        "summary": _text(summary),
        "report_path": _text(report_path),
        "failure_type": _text(ft),
        "outcome_state": outcome_state,
        "handoff_state": handoff_state,
        "timestamp": now_iso(),
        **{k: v for k, v in kwargs.items() if v not in (None, "")},
    }


def _task_state_update_cli(
    args: list[str],
    workspace: str = "",
    timeout: int = 30,
) -> dict[str, Any]:
    """Run task-state-update.py via subprocess with timeout."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "WORKSPACE": workspace or os.environ.get("WORKSPACE", "/workspace")},
        )
        return {
            "ok": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "subprocess_timeout", "stdout": "", "stderr": ""}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "stdout": "", "stderr": ""}


def relay_task_completion(
    task_id: str,
    status: str,
    summary: str = "",
    report_path: str = "",
    failure_type: str = "",
    workspace: str = "",
    **kwargs: Any,
) -> dict[str, Any]:
    """Single entry point for all task completions."""
    try:
        payload = build_completion_payload(
            task_id, status, summary, report_path, failure_type, **kwargs
        )

        # Build a mock task dict for state-machine validation
        task = {
            "id": _text(task_id),
            "lifecycle_state": "finalizing",
            "outcome_state": "pending",
            "handoff_state": "none",
            "status": _text(status),
        }

        target_lifecycle = ""
        target_outcome = payload["outcome_state"]
        target_handoff = ""

        validation = validate_transition(
            task,
            target_lifecycle=target_lifecycle,
            target_outcome=target_outcome,
            target_handoff=target_handoff,
        )

        if not validation["valid"]:
            return {
                "ok": False,
                "error": "invalid_transition",
                "violations": validation["violations"],
            }

        # Build CLI args for task-state-update.py
        tid = _text(task_id)
        s = _text(summary)
        rp = _text(report_path)
        ft = _text(failure_type)

        if status == "done":
            cli_args = [
                "python3", "lib/task-state-update.py", "done",
                "--id", tid,
                "--status", "done",
                "--summary", s,
                "--report-path", rp,
            ]
        elif status == "failed":
            cli_args = [
                "python3", "lib/task-state-update.py", "failed",
                "--id", tid,
                "--status", "failed",
                "--summary", s,
                "--failure-type", ft,
            ]
        elif status == "blocked":
            cli_args = [
                "python3", "lib/task-state-update.py", "blocked",
                "--id", tid,
                "--status", "blocked",
                "--summary", s,
            ]
        else:
            return {"ok": False, "error": f"unsupported_status: {status}"}

        cli_result = _task_state_update_cli(cli_args, workspace=workspace)
        if not cli_result.get("ok"):
            return {
                "ok": False,
                "error": "subprocess_failed",
                "stdout": cli_result.get("stdout", ""),
                "stderr": cli_result.get("stderr", ""),
            }

        # Emit lifecycle event if task_events is available
        events_emitted = False
        if append_task_event is not None:
            try:
                event_kind = {
                    "done": "task_completed",
                    "failed": "task_failed",
                    "blocked": "task_blocked",
                }.get(status, "task_completed")
                append_task_event(
                    {"id": tid, "status": status, "summary": s, "report_path": rp},
                    event_kind,
                    message=s,
                    extra={"failure_type": ft, "report_path": rp} if ft else {"report_path": rp},
                )
                events_emitted = True
            except Exception:
                events_emitted = False

        native_synced = False
        if sync_terminal_transition is not None:
            try:
                transition_map = {"done": "finished", "failed": "failed", "cancelled": "cancelled"}
                t_type = transition_map.get(status)
                if t_type:
                    real_task = _load_task_for_native_sync(tid, workspace)
                    if real_task:
                        sync_result = sync_terminal_transition(real_task, t_type)
                        native_synced = bool(sync_result.get("synced"))
            except Exception:
                native_synced = False

        return {
            "ok": True,
            "task_id": tid,
            "status": status,
            "events_emitted": events_emitted,
            "native_synced": native_synced,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def relay_child_completion(
    parent_id: str,
    child_id: str,
    child_status: str,
    child_summary: str = "",
    workspace: str = "",
) -> dict[str, Any]:
    """Relay a child task completion; parent aggregation handled by task-state-update.py."""
    result = relay_task_completion(
        task_id=child_id,
        status=child_status,
        summary=child_summary,
        workspace=workspace,
    )
    result["parent_id"] = _text(parent_id)
    return result
