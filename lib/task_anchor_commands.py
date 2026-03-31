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

from session_ops import send_agent_message
from task_display_cli import find_task, load_tasks, render_detail_text, render_queue_text, render_retrieval_text
from task_display import build_task_actions, build_task_detail, build_task_queue_view, build_task_retrieval_bundle, render_task_anchor_text

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
TASK_STATE_FILE = f"{WORKSPACE}/tmp/octopus/task-state.json"
TASK_STATE_UPDATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")

TASK_ACTION_ALIASES = {
    "view": "details",
    "detail": "details",
    "details": "details",
    "queue": "queue",
    "artifacts": "artifacts",
    "artifact": "artifacts",
    "retrieve": "retrieve",
    "result": "retrieve",
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

    if action == "stop":
        session_key = str(task.get("session_key", "") or "").strip()
        stop_result = send_agent_message(session_key, "/stop", timeout_seconds=0) if session_key else {"ok": False, "error": "missing session_key"}
        update_result = _run_task_state_upsert(
            task_id,
            status="deferred",
            summary="Operator requested stop; task deferred",
            recovery_action="operator_stop_request",
        )
        ok = bool(stop_result.get("ok")) or bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"stop_result": stop_result, "update_result": update_result},
            "text": f"Stop requested for {task_id}.",
        }

    if action == "retry":
        retry_count = int(task.get("retry_count", 0) or 0) + 1
        update_result = _run_task_state_upsert(
            task_id,
            status="queued",
            summary="Manual retry requested by operator",
            recovery_action="manual_retry_request",
            retry_count=retry_count,
        )
        return {
            "ok": bool(update_result.get("ok")),
            "status": "ok" if update_result.get("ok") else "error",
            "action": action,
            "task_id": task_id,
            "data": {"update_result": update_result},
            "text": f"Retry queued for {task_id}." if update_result.get("ok") else f"Retry failed for {task_id}.",
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
        message_result = send_agent_message(session_key, "Rejected. Stop this task and wait for a new instruction.", timeout_seconds=0) if session_key else {"ok": False, "error": "missing session_key"}
        update_result = _run_task_state_upsert(
            task_id,
            status="deferred",
            summary="Rejected by operator; task deferred",
            recovery_action="operator_rejected",
        )
        ok = bool(message_result.get("ok")) or bool(update_result.get("ok"))
        return {
            "ok": ok,
            "status": "ok" if ok else "error",
            "action": action,
            "task_id": task_id,
            "data": {"message_result": message_result, "update_result": update_result},
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
