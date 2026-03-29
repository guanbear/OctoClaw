#!/usr/bin/env python3
"""Thin wrappers for OpenClaw session-aware gateway actions."""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from typing import Any


def has_openclaw_cli() -> bool:
    return shutil.which("openclaw") is not None


def gateway_call(method: str, params: dict, timeout_ms: int = 10000) -> dict:
    """
    Call `openclaw gateway call` and parse JSON output.
    Returns {} on failure so patrol can gracefully degrade.
    """
    if not has_openclaw_cli():
        return {}
    try:
        result = subprocess.run(
            [
                "openclaw",
                "gateway",
                "call",
                method,
                "--params",
                json.dumps(params, ensure_ascii=False),
                "--json",
                "--timeout",
                str(timeout_ms),
            ],
            capture_output=True,
            text=True,
            timeout=max(3, int(timeout_ms / 1000) + 2),
        )
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr or result.stdout or "").strip()}
        payload = json.loads(result.stdout or "{}")
        if isinstance(payload, dict):
            return payload
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {}


def send_agent_message(session_key: str, message: str, timeout_seconds: int = 0) -> dict:
    """
    Continue an existing session via gateway `agent` RPC.
    This is the patrol-friendly equivalent of "send/steer the current subagent".
    """
    if not session_key or not message.strip():
        return {"ok": False, "status": "error", "error": "missing session_key or message"}

    idem = f"octopus-steer-{uuid.uuid4()}"
    params = {
        "sessionKey": session_key,
        "message": message,
        "idempotencyKey": idem,
    }
    response = gateway_call("agent", params, timeout_ms=10000)
    if not isinstance(response, dict):
        return {"ok": False, "status": "error", "error": "invalid gateway response"}

    run_id = response.get("runId") if isinstance(response.get("runId"), str) else ""
    if timeout_seconds <= 0 or not run_id:
        if "status" not in response:
            response["status"] = "accepted" if run_id else "error"
        return response

    wait_res = gateway_call(
        "agent.wait",
        {"runId": run_id, "timeoutMs": max(0, int(timeout_seconds * 1000))},
        timeout_ms=max(10000, int(timeout_seconds * 1000) + 5000),
    )
    if not isinstance(wait_res, dict):
        return {"ok": False, "status": "error", "runId": run_id, "error": "invalid agent.wait response"}
    wait_res.setdefault("runId", run_id)
    return wait_res


def send_channel_message(
    channel: str,
    target: str,
    message: str,
    *,
    reply_to: str = "",
    thread_id: str = "",
    components: dict[str, Any] | None = None,
    timeout_seconds: int = 20,
) -> dict:
    """
    Send an outbound channel message through OpenClaw's native message CLI.
    This keeps OctoClaw transport-thin and lets upstream own provider details.
    """
    if not has_openclaw_cli():
        return {"ok": False, "status": "error", "error": "openclaw cli unavailable"}
    channel_value = str(channel or "").strip()
    target_value = str(target or "").strip()
    if not channel_value or not target_value:
        return {"ok": False, "status": "error", "error": "missing channel or target"}

    cmd = [
        "openclaw",
        "message",
        "send",
        "--channel",
        channel_value,
        "--target",
        target_value,
        "--json",
    ]
    if message.strip():
        cmd.extend(["--message", message])
    if reply_to.strip():
        cmd.extend(["--reply-to", reply_to.strip()])
    if thread_id.strip():
        cmd.extend(["--thread-id", thread_id.strip()])
    if components:
        cmd.extend(["--components", json.dumps(components, ensure_ascii=False)])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(5, int(timeout_seconds)),
        )
        if result.returncode != 0:
            return {
                "ok": False,
                "status": "error",
                "error": (result.stderr or result.stdout or "").strip(),
            }
        payload = json.loads(result.stdout or "{}")
        if isinstance(payload, dict):
            payload.setdefault("ok", True)
            return payload
    except Exception as exc:
        return {"ok": False, "status": "error", "error": str(exc)}
    return {"ok": False, "status": "error", "error": "invalid message send response"}
