#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from openclaw_taskflow_adapter import cancel_native_taskflow
from octopus_config import TASK_STATE_FILE
from session_ops import send_agent_message
from task_display_cli import (
    find_task,
    load_tasks,
    render_detail_text,
    render_explorer_text,
    render_graph_text,
    render_queue_text,
    render_retrieval_text,
    render_timeline_text,
)
from task_display import (
    build_task_actions,
    build_task_artifact_explorer,
    build_task_detail,
    build_task_graph,
    build_task_queue_view,
    build_task_retrieval_bundle,
    build_task_timeline,
    render_task_anchor_text,
)

TASK_STATE_UPDATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")
ACTIVE_TASK_STATUSES = {"queued", "dispatched", "running", "blocked", "needs_approval", "pending_confirm"}

TASK_ACTION_ALIASES = {
    "view": "details",
    "detail": "details",
    "details": "details",
    "queue": "queue",
    "artifacts": "artifacts",
    "artifact": "artifacts",
    "retrieve": "retrieve",
    "result": "retrieve",
    "graph": "graph",
    "timeline": "timeline",
    "explorer": "explorer",
    "explore": "explorer",
    "stop": "stop",
    "retry": "retry",
    "approve": "approve",
    "reject": "reject",
}


def parse_task_anchor_command(text: str) -> dict[str, str]:
    raw = " ".join(str(text or "").strip().split())
    if not raw:
        return {"ok": False, "error": "empty command"}
    parts = raw.split()
    action = TASK_ACTION_ALIASES.get(parts[0].lower(), "")
    if not action:
        return {"ok": False, "error": "unsupported command"}
    task_id = ""
    if action != "queue":
        if len(parts) < 2:
            return {"ok": False, "error": "missing task id"}
        task_id = parts[1].strip()
    return {"ok": True, "action": action, "task_id": task_id}


def _run_task_state_upsert(task_id: str, **fields: Any) -> dict[str, Any]:
    cmd = ["python3", TASK_STATE_UPDATE_PY, "upsert", "--id", str(task_id)]
    mapping = {
        "status": "--status",
        "summary": "--summary",
        "recovery_action": "--recovery-action",
        "retry_count": "--retry-count",
    }
    for key, flag in mapping.items():
        value = fields.get(key)
        if value is None or str(value).strip() == "":
            continue
        cmd.extend([flag, str(value)])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "cmd": cmd}
    return {
        "ok": result.returncode == 0,
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
        "cmd": cmd,
    }


def _run_task_state_event(task_id: str, kind: str, message: str, *, event_json: dict[str, Any] | None = None) -> dict[str, Any]:
    cmd = [
        "python3",
        TASK_STATE_UPDATE_PY,
        "event",
        "--id",
        str(task_id),
        "--kind",
        str(kind),
        "--message",
        str(message),
    ]
    if isinstance(event_json, dict) and event_json:
        cmd.extend(["--event-json", json.dumps(event_json, ensure_ascii=False)])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "cmd": cmd}
    return {
        "ok": result.returncode == 0,
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
        "cmd": cmd,
    }


def _task_text(value: Any) -> str:
    return str(value or "").strip()


def _taskflow_binding(task: dict[str, Any]) -> dict[str, Any]:
    explicit = dict(task.get("openclaw_taskflow", {})) if isinstance(task.get("openclaw_taskflow"), dict) else {}
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    artifact_binding = dict(artifacts.get("openclaw_taskflow", {})) if isinstance(artifacts.get("openclaw_taskflow"), dict) else {}
    merged = dict(artifact_binding)
    for key, value in explicit.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def _task_has_native_binding(task: dict[str, Any]) -> bool:
    binding = _taskflow_binding(task)
    return bool(
        _task_text(task.get("openclaw_task_id"))
        or _task_text(task.get("openclaw_flow_id"))
        or _task_text(binding.get("task_id"))
        or _task_text(binding.get("flow_id"))
    )


def _task_looks_active(task: dict[str, Any]) -> bool:
    status = _task_text(task.get("status")).lower()
    native_status = _task_text(task.get("openclaw_native_status")).lower()
    return status in ACTIVE_TASK_STATUSES or native_status in {"queued", "running", "blocked"}


def _cancel_native_if_available(task: dict[str, Any]) -> dict[str, Any]:
    if not _task_has_native_binding(task):
        return {"ok": False, "status": "skipped", "error": "no native binding"}
    return cancel_native_taskflow(task)


def execute_task_anchor_command(
    text: str,
    *,
    state_file: str = TASK_STATE_FILE,
    output_format: str = "text",
) -> dict[str, Any]:
    parsed = parse_task_anchor_command(text)
    if not parsed.get("ok"):
        return {"ok": False, "status": "error", "error": parsed.get("error", "invalid command")}

    action = str(parsed.get("action", "") or "")
    tasks = load_tasks(state_file)

    if action == "queue":
        queue_view = build_task_queue_view(tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "data": queue_view, "text": json.dumps(queue_view, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "data": queue_view, "text": render_queue_text(queue_view)}

    task_id = str(parsed.get("task_id", "") or "")
    task = find_task(tasks, task_id)
    if not task:
        return {"ok": False, "status": "not_found", "action": action, "task_id": task_id, "error": f"task not found: {task_id}"}

    if action == "details":
        detail = build_task_detail(task, all_tasks=tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": detail, "text": json.dumps(detail, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": detail, "text": render_detail_text(task, detail)}

    if action == "artifacts":
        detail = build_task_detail(task, all_tasks=tasks)
        artifacts = detail.get("artifacts", [])
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": artifacts, "text": json.dumps(artifacts, ensure_ascii=False, indent=2)}
        if not artifacts:
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": artifacts, "text": "(no artifacts)"}
        lines = []
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            title = str(artifact.get("title", "") or artifact.get("artifact_id", "artifact")).strip()
            path = str(artifact.get("path", "") or artifact.get("preview", "") or "").strip()
            lines.append(f"- {title}: {path}".rstrip(": "))
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": artifacts, "text": "\n".join(lines)}

    if action == "retrieve":
        bundle = build_task_retrieval_bundle(task, all_tasks=tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": bundle, "text": json.dumps(bundle, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": bundle, "text": render_retrieval_text(bundle)}

    if action == "graph":
        graph = build_task_graph(task, all_tasks=tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": graph, "text": json.dumps(graph, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": graph, "text": render_graph_text(graph)}

    if action == "timeline":
        timeline = build_task_timeline(task, all_tasks=tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": timeline, "text": json.dumps(timeline, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": timeline, "text": render_timeline_text(timeline)}

    if action == "explorer":
        explorer = build_task_artifact_explorer(task, all_tasks=tasks)
        if output_format == "json":
            return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": explorer, "text": json.dumps(explorer, ensure_ascii=False, indent=2)}
        return {"ok": True, "status": "ok", "action": action, "task_id": task_id, "data": explorer, "text": render_explorer_text(explorer)}

    if action == "stop":
        session_key = str(task.get("session_key", "") or "").strip()
        native_result = _cancel_native_if_available(task)
        stop_result = (
            send_agent_message(session_key, "/stop", timeout_seconds=0)
            if session_key and not native_result.get("ok")
            else {"ok": False, "status": "skipped", "error": "native cancel handled stop"}
        )
        update_result = _run_task_state_upsert(
            task_id,
            status="deferred",
            summary="Operator requested stop; task deferred",
            recovery_action="operator_stop_request",
        )
        event_result = _run_task_state_event(
            task_id,
            "job_cancelled",
            "operator requested stop",
            event_json={
                "action": "stop",
                "native_status": str(native_result.get("status", "") or ""),
                "session_stop_status": str(stop_result.get("status", "") or ""),
            },
        )
        ok = bool(native_result.get("ok")) or bool(stop_result.get("ok")) or bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"native_result": native_result, "stop_result": stop_result, "update_result": update_result, "event_result": event_result},
            "text": f"Stop requested for {task_id}.",
        }

    if action == "retry":
        native_result = _cancel_native_if_available(task) if _task_looks_active(task) else {"ok": False, "status": "skipped", "error": "task is not active"}
        session_key = str(task.get("session_key", "") or "").strip()
        stop_result = (
            send_agent_message(session_key, "/stop", timeout_seconds=0)
            if session_key and _task_looks_active(task) and not native_result.get("ok")
            else {"ok": False, "status": "skipped", "error": "native cancel handled retry pre-stop"}
        )
        retry_count = int(task.get("retry_count", 0) or 0) + 1
        update_result = _run_task_state_upsert(
            task_id,
            status="queued",
            summary="Manual retry requested by operator",
            recovery_action="manual_retry_request",
            retry_count=retry_count,
        )
        event_result = _run_task_state_event(
            task_id,
            "job_superseded",
            "manual retry superseded previous run",
            event_json={
                "action": "retry",
                "retry_count": retry_count,
                "native_status": str(native_result.get("status", "") or ""),
                "session_stop_status": str(stop_result.get("status", "") or ""),
            },
        )
        ok = bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"native_result": native_result, "stop_result": stop_result, "update_result": update_result, "event_result": event_result},
            "text": f"Retry queued for {task_id}." if ok else f"Retry failed for {task_id}.",
        }

    if action == "approve":
        session_key = str(task.get("session_key", "") or "").strip()
        message_result = send_agent_message(session_key, "Approved. Continue with the task.", timeout_seconds=0) if session_key else {"ok": False, "error": "missing session_key"}
        update_result = _run_task_state_upsert(
            task_id,
            status="queued",
            summary="Approved by operator; continue execution",
            recovery_action="operator_approved",
        )
        ok = bool(message_result.get("ok")) or bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"message_result": message_result, "update_result": update_result},
            "text": f"Approved {task_id}.",
        }

    if action == "reject":
        session_key = str(task.get("session_key", "") or "").strip()
        native_result = _cancel_native_if_available(task) if _task_looks_active(task) else {"ok": False, "status": "skipped", "error": "task is not active"}
        message_result = (
            send_agent_message(session_key, "Rejected. Stop this task and wait for a new instruction.", timeout_seconds=0)
            if session_key and not native_result.get("ok")
            else {"ok": False, "status": "skipped", "error": "native cancel handled rejection"}
        )
        update_result = _run_task_state_upsert(
            task_id,
            status="deferred",
            summary="Rejected by operator; task deferred",
            recovery_action="operator_rejected",
        )
        event_result = _run_task_state_event(
            task_id,
            "job_cancelled",
            "operator rejected task",
            event_json={
                "action": "reject",
                "native_status": str(native_result.get("status", "") or ""),
                "session_stop_status": str(message_result.get("status", "") or ""),
            },
        )
        ok = bool(native_result.get("ok")) or bool(message_result.get("ok")) or bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"native_result": native_result, "message_result": message_result, "update_result": update_result, "event_result": event_result},
            "text": f"Rejected {task_id}.",
        }

    return {"ok": False, "status": "error", "task_id": task_id, "error": "unsupported action"}


def main() -> int:
    parser = argparse.ArgumentParser(description="OctoClaw task anchor command handler")
    parser.add_argument("--state-file", default=TASK_STATE_FILE)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("text", nargs="+", help="task anchor fallback command")
    args = parser.parse_args()

    result = execute_task_anchor_command(" ".join(args.text), state_file=args.state_file, output_format=args.format)
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(str(result.get("text", result.get("error", "")) or "").strip())
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
