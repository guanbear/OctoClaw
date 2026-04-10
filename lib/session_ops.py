#!/usr/bin/env python3
"""Thin wrappers for OpenClaw session-aware gateway actions."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from task_events import register_session_binding
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_events import register_session_binding


def has_openclaw_cli() -> bool:
    return shutil.which("openclaw") is not None


def _load_openclaw_gateway_token() -> str:
    env_token = str(os.environ.get("OPENCLAW_GATEWAY_TOKEN", "") or "").strip()
    if env_token:
        return env_token
    config_path = Path(os.path.expanduser("~/.openclaw/openclaw.json"))
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    gateway = payload.get("gateway", {}) if isinstance(payload.get("gateway"), dict) else {}
    auth = gateway.get("auth", {}) if isinstance(gateway.get("auth"), dict) else {}
    if str(auth.get("mode", "") or "").strip().lower() != "token":
        return ""
    return str(auth.get("token", "") or "").strip()


def gateway_call(method: str, params: dict, timeout_ms: int = 10000) -> dict:
    """
    Call `openclaw gateway call` and parse JSON output.
    Returns {} on failure so patrol can gracefully degrade.
    """
    if not has_openclaw_cli():
        return {}
    token = _load_openclaw_gateway_token()
    cmd = [
        "openclaw",
        "gateway",
        "call",
        method,
        "--params",
        json.dumps(params, ensure_ascii=False),
        "--json",
        "--timeout",
        str(timeout_ms),
    ]
    if token:
        cmd.extend(["--token", token])
    try:
        result = subprocess.run(
            cmd,
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

    idem = f"octoclaw-steer-{uuid.uuid4()}"
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


TRANSIENT_MESSAGE_ERROR_SNIPPETS = (
    "timed out",
    "timeout",
    "temporarily unavailable",
    "connection reset",
    "econnreset",
    "broken pipe",
    "eof",
)


def _looks_transient_message_error(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    return any(snippet in lowered for snippet in TRANSIENT_MESSAGE_ERROR_SNIPPETS)


def _run_message_cli(cmd: list[str], *, timeout_seconds: int = 20, retry_attempts: int = 1) -> dict:
    attempts = max(1, int(retry_attempts) + 1)
    last_error = "invalid message send response"
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(5, int(timeout_seconds)),
            )
            if result.returncode == 0:
                payload = json.loads(result.stdout or "{}")
                if isinstance(payload, dict):
                    payload.setdefault("ok", True)
                    if attempt > 1:
                        payload.setdefault("retry_count", attempt - 1)
                    return payload
                last_error = "invalid message send response"
            else:
                last_error = (result.stderr or result.stdout or "").strip() or "message command failed"
        except subprocess.TimeoutExpired:
            last_error = f"message send timed out after {timeout_seconds}s"
        except Exception as exc:
            last_error = str(exc)
        if attempt < attempts and _looks_transient_message_error(last_error):
            time.sleep(0.4)
            continue
        break
    return {"ok": False, "status": "error", "error": last_error}


def _strip_agent_prefix(session_key: str) -> str:
    raw = str(session_key or "").strip()
    if not raw:
        return ""
    parts = raw.split(":")
    if len(parts) >= 3 and parts[0] == "agent":
        return ":".join(parts[2:])
    return raw


def resolve_message_target_from_session_key(session_key: str) -> dict:
    """
    Best-effort conversion from OpenClaw session keys to `openclaw message send`
    channel/target/thread parameters.
    """
    stripped = _strip_agent_prefix(session_key)
    parts = [part for part in stripped.split(":") if part != ""]
    if not parts:
        return {"ok": False, "error": "missing session key"}

    origin = parts[0].lower()
    thread_id = ""
    target = ""

    if origin == "slack":
        if len(parts) >= 3 and parts[1] in {"dm", "direct", "user"}:
            target = f"user:{parts[2]}"
            if len(parts) >= 5 and parts[3] == "thread":
                thread_id = parts[4]
        elif len(parts) >= 3 and parts[1] == "channel":
            target = f"channel:{parts[2]}"
            if len(parts) >= 5 and parts[3] == "thread":
                thread_id = parts[4]
    elif origin == "discord":
        if len(parts) >= 3 and parts[1] == "channel":
            target = f"channel:{parts[2]}"
            if len(parts) >= 5 and parts[3] == "thread":
                target = f"channel:{parts[4]}"
        elif len(parts) >= 3 and parts[1] in {"dm", "direct", "user"}:
            target = f"user:{parts[2]}"
    elif origin == "telegram":
        if len(parts) >= 3 and parts[1] == "group":
            target = parts[2]
            if len(parts) >= 5 and parts[3] in {"topic", "thread"}:
                thread_id = parts[4]
        elif len(parts) >= 2:
            target = parts[1]
            if len(parts) >= 4 and parts[2] == "thread":
                thread_id = parts[3]
    elif origin == "whatsapp":
        if len(parts) >= 3 and parts[1] == "group":
            target = f"group:{parts[2]}"
        elif len(parts) >= 2:
            target = parts[1]
    elif origin == "signal":
        if len(parts) >= 3 and parts[1] == "group":
            target = f"group:{parts[2]}"
        elif len(parts) >= 2:
            target = parts[1]
    elif origin == "msteams":
        if len(parts) >= 3 and parts[1] == "conversation":
            target = f"conversation:{parts[2]}"
        elif len(parts) >= 3 and parts[1] == "user":
            target = f"user:{parts[2]}"
    elif origin == "googlechat":
        if len(parts) >= 3:
            target = f"{parts[1]}:{parts[2]}" if parts[1] in {"spaces", "users"} else ":".join(parts[1:])
    if not target:
        if len(parts) >= 3 and parts[1] in {"dm", "direct", "user"}:
            target = f"user:{parts[2]}"
            if len(parts) >= 5 and parts[3] in {"thread", "topic"}:
                thread_id = parts[4]
        elif len(parts) >= 3 and parts[1] in {"channel", "group", "room", "conversation", "space", "chat"}:
            target = f"{parts[1]}:{parts[2]}"
            if len(parts) >= 5 and parts[3] in {"thread", "topic"}:
                thread_id = parts[4]
        elif len(parts) >= 3 and parts[1] in {"thread", "topic"}:
            target = f"{parts[1]}:{parts[2]}"
        elif len(parts) >= 2:
            target = ":".join(parts[1: min(3, len(parts))])

    if not target:
        return {
            "ok": False,
            "origin": origin,
            "session_key": session_key,
            "error": "unsupported or unresolvable session target",
        }

    payload = {
        "ok": True,
        "origin": origin,
        "session_key": session_key,
        "target": target,
        "thread_id": thread_id,
    }
    try:
        register_session_binding(session_key, payload, source="session_resolve")
    except Exception:
        pass
    return payload


def send_channel_message(
    channel: str,
    target: str,
    message: str,
    *,
    reply_to: str = "",
    thread_id: str = "",
    interactive: dict[str, Any] | None = None,
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
    if interactive:
        cmd.extend(["--interactive", json.dumps(interactive, ensure_ascii=False)])
    if components:
        cmd.extend(["--components", json.dumps(components, ensure_ascii=False)])

    return _run_message_cli(cmd, timeout_seconds=timeout_seconds, retry_attempts=1)


def edit_channel_message(
    channel: str,
    target: str,
    message_id: str,
    message: str,
    *,
    timeout_seconds: int = 20,
) -> dict:
    """
    Edit an outbound channel message through OpenClaw's native message CLI.
    """
    if not has_openclaw_cli():
        return {"ok": False, "status": "error", "error": "openclaw cli unavailable"}
    channel_value = str(channel or "").strip()
    target_value = str(target or "").strip()
    message_id_value = str(message_id or "").strip()
    if not channel_value or not target_value or not message_id_value:
        return {"ok": False, "status": "error", "error": "missing channel, target, or message_id"}

    cmd = [
        "openclaw",
        "message",
        "edit",
        "--channel",
        channel_value,
        "--target",
        target_value,
        "--message-id",
        message_id_value,
        "--message",
        message,
        "--json",
    ]

    return _run_message_cli(cmd, timeout_seconds=timeout_seconds, retry_attempts=1)
