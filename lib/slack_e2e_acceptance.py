#!/usr/bin/env python3
"""Black-box Slack E2E acceptance harness for OctoClaw/OpenClaw sessions."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    from octopus_config import MAIN_AGENT_SESSIONS_FILE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import MAIN_AGENT_SESSIONS_FILE

try:
    from session_ops import send_agent_message
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.session_ops import send_agent_message


COMMON_BIN_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.npm-global/bin"),
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.bun/bin"),
    os.path.expanduser("~/.volta/bin"),
    os.path.expanduser("~/.nvm/versions/node/current/bin"),
]

SMOKE_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "fresh_live_lookup",
        "prompt": "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 90,
    },
    {
        "name": "provenance_followup",
        "prompt": "怎么查的",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 45,
    },
    {
        "name": "local_surface_lookup",
        "prompt": "你的control ui访问地址是啥",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 45,
        "assertions": {
            "final_must_include_any": ["127.0.0.1", "localhost", "http://", "https://"],
        },
    },
]

CORE_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "plain_chat",
        "prompt": "在吗",
        "ack_deadline_ms": 1000,
        "final_timeout_s": 30,
    },
    *SMOKE_SCENARIOS[:1],
    {
        "name": "provenance_followup",
        "prompt": "怎么查的",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 45,
        "assertions": {
            "must_not_include_any": [
                "route 判定",
                "spawn_single",
                "direct_answer",
                "playbook",
                "regex",
                "route=",
            ],
        },
    },
    *SMOKE_SCENARIOS[2:3],
    {
        "name": "execution_followup",
        "prompt": "刚才那个任务判定是啥",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 45,
        "assertions": {
            "must_not_include_any": [
                "route 判定",
                "spawn_single",
                "direct_answer",
                "playbook",
                "regex",
                "route=",
            ],
        },
    },
    {
        "name": "delegated_work",
        "prompt": "帮我查一下最近 release，给我 5 句话总结",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 120,
    },
]

ACCEPTANCE_SCENARIOS: list[dict[str, Any]] = [
    *CORE_SCENARIOS,
    {
        "name": "compound_request",
        "prompt": "早上好，你是啥模型，请帮我查下 openclaw 的最新版本。如果有新版本帮我更新下",
        "ack_deadline_ms": 1500,
        "final_timeout_s": 180,
    },
]

PRESET_SCENARIOS: dict[str, list[dict[str, Any]]] = {
    "smoke": SMOKE_SCENARIOS,
    "core6": CORE_SCENARIOS,
    "acceptance": ACCEPTANCE_SCENARIOS,
}


def resolve_openclaw_home() -> Path:
    configured = _text(os.environ.get("OPENCLAW_HOME"))
    if configured:
        return Path(os.path.expanduser(configured))
    return Path(os.path.expanduser("~/.openclaw"))


def default_openclaw_config_path() -> str:
    return str(resolve_openclaw_home() / "openclaw.json")


def default_sessions_path() -> str:
    configured = _text(os.environ.get("OCTOCLAW_ACCEPTANCE_SESSIONS_PATH"))
    if configured:
        return configured
    return str(resolve_openclaw_home() / "agents" / "main" / "sessions" / "sessions.json")


def _text(value: Any) -> str:
    return str(value or "").strip()


def build_harness_prompt(scenario_name: str, prompt: str) -> str:
    return (
        f"[codex-slack-e2e scenario={_text(scenario_name) or 'unknown'}] "
        "这是自动化验收消息。只基于本条里的用户问题作答，并正常回复到 Slack。\n\n"
        f"当前用户问题：{_text(prompt)}"
    ).strip()


def load_json(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def has_openclaw_cli() -> bool:
    return bool(locate_openclaw_cli())


def locate_openclaw_cli() -> str:
    explicit = _text(os.environ.get("OPENCLAW_BIN"))
    if explicit:
        return explicit
    resolved = shutil.which("openclaw")
    if resolved:
        return resolved
    for candidate in (
        "/opt/homebrew/bin/openclaw",
        "/usr/local/bin/openclaw",
        os.path.expanduser("~/.npm-global/bin/openclaw"),
    ):
        if os.path.exists(candidate):
            return candidate
    return ""


def build_exec_env() -> dict[str, str]:
    env = dict(os.environ)
    path_parts = [_text(env.get("PATH"))]
    path_parts.extend(COMMON_BIN_DIRS)
    env["PATH"] = ":".join(part for part in path_parts if part)
    gateway_cfg = load_json(default_openclaw_config_path()).get("gateway", {})
    if isinstance(gateway_cfg, dict):
        port = gateway_cfg.get("port", 18789)
        bind = _text(gateway_cfg.get("bind")) or "127.0.0.1"
        if bind == "loopback":
            bind = "127.0.0.1"
        auth = gateway_cfg.get("auth", {}) if isinstance(gateway_cfg.get("auth"), dict) else {}
        token = _text(auth.get("token"))
        mode = _text(gateway_cfg.get("mode")) or "local"
        if mode == "local":
            env.setdefault("OPENCLAW_GATEWAY_URL", f"ws://{bind}:{port}")
        if token:
            env.setdefault("OPENCLAW_GATEWAY_TOKEN", token)
    return env


def load_slack_config(config_path: str = "") -> dict[str, Any]:
    config_path = _text(config_path) or default_openclaw_config_path()
    payload = load_json(config_path)
    channels = payload.get("channels", {}) if isinstance(payload.get("channels"), dict) else {}
    slack = channels.get("slack", {}) if isinstance(channels.get("slack"), dict) else {}
    env_bot_token = _text(os.environ.get("OCTOCLAW_SLACK_BOT_TOKEN") or os.environ.get("OPENCLAW_SLACK_BOT_TOKEN"))
    env_app_token = _text(os.environ.get("OCTOCLAW_SLACK_APP_TOKEN") or os.environ.get("OPENCLAW_SLACK_APP_TOKEN"))
    return {
        "config_path": config_path,
        "enabled": bool(slack.get("enabled")),
        "bot_token": env_bot_token or _text(slack.get("botToken")),
        "app_token": env_app_token or _text(slack.get("appToken")),
        "group_policy": _text(slack.get("groupPolicy")),
        "dm_policy": _text(slack.get("dmPolicy")),
    }


def load_main_sessions(sessions_path: str = MAIN_AGENT_SESSIONS_FILE) -> dict[str, Any]:
    payload = load_json(sessions_path)
    return payload if isinstance(payload, dict) else {}


def normalize_session_entry(session_key: str, raw: dict[str, Any]) -> dict[str, Any]:
    origin = raw.get("origin", {}) if isinstance(raw.get("origin"), dict) else {}
    delivery = raw.get("deliveryContext", {}) if isinstance(raw.get("deliveryContext"), dict) else {}
    native_channel_id = _text(origin.get("nativeChannelId"))
    thread_id = _text(delivery.get("threadId") or origin.get("threadId") or raw.get("lastThreadId"))
    target = _text(delivery.get("to") or origin.get("to"))
    return {
        "session_key": _text(session_key),
        "updated_at": int(raw.get("updatedAt", 0) or 0),
        "chat_type": _text(raw.get("chatType") or origin.get("chatType")),
        "provider": _text(origin.get("provider") or origin.get("surface") or raw.get("channel")),
        "target": target,
        "native_channel_id": native_channel_id,
        "thread_id": thread_id,
        "account_id": _text(delivery.get("accountId") or origin.get("accountId")),
        "display_name": _text(raw.get("displayName")),
        "session_id": _text(raw.get("sessionId")),
    }


def choose_slack_session(
    sessions_path: str = "",
    *,
    session_key: str = "",
    target: str = "",
    native_channel_id: str = "",
    thread_id: str = "",
    chat_type: str = "",
    prefer_direct: bool = True,
    require_native_channel: bool = True,
) -> dict[str, Any]:
    sessions_path = _text(sessions_path) or default_sessions_path() or MAIN_AGENT_SESSIONS_FILE
    sessions = load_main_sessions(sessions_path)
    explicit_session_key = _text(session_key)
    explicit_target = _text(target)
    explicit_native_channel_id = _text(native_channel_id)
    explicit_thread_id = _text(thread_id)
    entries = []
    for key, value in sessions.items():
        if not isinstance(value, dict):
            continue
        normalized = normalize_session_entry(str(key), value)
        if normalized["provider"] != "slack":
            continue
        if explicit_session_key and normalized["session_key"] != explicit_session_key:
            continue
        if explicit_target and normalized["target"] != explicit_target:
            continue
        if explicit_native_channel_id and normalized["native_channel_id"] and normalized["native_channel_id"] != explicit_native_channel_id:
            continue
        if explicit_thread_id and normalized["thread_id"] and normalized["thread_id"] != explicit_thread_id:
            continue
        if chat_type and normalized["chat_type"] != chat_type:
            continue
        if explicit_native_channel_id and not normalized["native_channel_id"]:
            normalized["native_channel_id"] = explicit_native_channel_id
        if explicit_thread_id and not normalized["thread_id"]:
            normalized["thread_id"] = explicit_thread_id
        if explicit_target and not normalized["target"]:
            normalized["target"] = explicit_target
        if require_native_channel and not normalized["native_channel_id"]:
            continue
        entries.append(normalized)
    if not entries:
        return {}
    entries.sort(
        key=lambda item: (
            1 if item.get("thread_id") else 0,
            1 if prefer_direct and item.get("chat_type") == "direct" else 0,
            int(item.get("updated_at", 0) or 0),
        ),
        reverse=True,
    )
    return entries[0]


def get_scenarios_for_preset(preset: str) -> list[dict[str, Any]]:
    rows = PRESET_SCENARIOS.get(_text(preset))
    return [dict(item) for item in rows] if rows else [dict(item) for item in SMOKE_SCENARIOS]


def inspect_replay_source(spec: str) -> dict[str, Any]:
    raw = _text(spec)
    if not raw:
        return {"ok": False, "error": "empty replay source"}
    if "=" in raw:
        label, path_text = raw.split("=", 1)
    else:
        label, path_text = "", raw
    label = _text(label) or Path(path_text).expanduser().name or "replay_source"
    root = Path(path_text).expanduser()
    if not root.exists():
        return {"ok": False, "label": label, "path": str(root), "error": "path not found"}

    def _find_file(base: Path, *candidates: str) -> str:
        for candidate in candidates:
            path = base / candidate
            if path.exists():
                return str(path)
        return ""

    sessions_index = ""
    replay_log = ""
    task_state = ""
    session_file_count = 0
    if root.is_dir():
        sessions_index = _find_file(root, "sessions.json", "merged/sessions.json")
        replay_log = _find_file(root, "runtime-policy-replay.jsonl", "merged/runtime-policy-replay.jsonl")
        task_state = _find_file(root, "task-state.json", "merged/task-state.json")
        session_dir = ""
        sessions_dir_candidate = root / "sessions"
        if sessions_dir_candidate.exists():
            session_dir = str(sessions_dir_candidate)
        elif sessions_index.endswith("merged/sessions.json") and (root / "sessions").exists():
            session_dir = str(root / "sessions")
        session_candidates = list(root.rglob("session-*.json"))
        session_file_count = len(session_candidates)
    else:
        file_name = root.name
        session_dir = ""
        if file_name == "sessions.json":
            sessions_index = str(root)
        elif file_name == "runtime-policy-replay.jsonl":
            replay_log = str(root)
        elif file_name == "task-state.json":
            task_state = str(root)
    return {
        "ok": True,
        "label": label,
        "path": str(root),
        "is_dir": root.is_dir(),
        "sessions_index": sessions_index,
        "session_dir": session_dir,
        "replay_log": replay_log,
        "task_state": task_state,
        "session_file_count": session_file_count,
    }


def slack_api_call(token: str, method: str, params: dict[str, Any] | None = None, *, timeout: int = 15) -> dict[str, Any]:
    payload = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    data = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_channel_id_for_target(token: str, target: str, native_channel_id: str = "") -> str:
    if native_channel_id:
        return native_channel_id
    normalized = _text(target)
    if normalized.startswith("channel:"):
        return normalized.split(":", 1)[1].strip()
    if normalized.startswith("user:"):
        response = slack_api_call(token, "conversations.open", {"users": normalized.split(":", 1)[1].strip()})
        channel = response.get("channel", {}) if isinstance(response.get("channel"), dict) else {}
        return _text(channel.get("id"))
    return normalized


def launch_agent_turn(
    session: dict[str, Any],
    prompt: str,
    *,
    timeout_s: int = 180,
) -> dict[str, Any]:
    session_key = _text(session.get("session_key"))
    if session_key and not _text(session.get("session_id")):
        gateway_result = send_agent_message(session_key, prompt, timeout_seconds=0)
        ok = bool(gateway_result.get("ok")) or _text(gateway_result.get("status")) in {"accepted", "queued"}
        return {
            "ok": ok,
            "mode": "gateway_rpc",
            "gateway_result": gateway_result,
            "command": ["openclaw", "gateway", "call", "agent"],
            "timeout_s": timeout_s,
        }
    openclaw_bin = locate_openclaw_cli()
    if not openclaw_bin:
        return {"ok": False, "error": "openclaw cli unavailable"}
    session_id = _text(session.get("session_id"))
    if not session_id:
        return {"ok": False, "error": "missing session_id"}
    cmd = [
        openclaw_bin,
        "agent",
        "--session-id",
        session_id,
        "--message",
        prompt,
        "--deliver",
        "--json",
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=build_exec_env(),
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "command": cmd}
    return {
        "ok": True,
        "mode": "cli",
        "process": proc,
        "command": cmd,
        "timeout_s": timeout_s,
    }


def fetch_slack_messages(
    token: str,
    *,
    channel_id: str,
    thread_id: str = "",
    oldest: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    if not channel_id:
        return []
    params: dict[str, Any] = {
        "channel": channel_id,
        "limit": max(1, int(limit)),
        "inclusive": False,
    }
    if oldest:
        params["oldest"] = oldest
    method = "conversations.replies" if thread_id else "conversations.history"
    if thread_id:
        params["ts"] = thread_id
    response = slack_api_call(token, method, params)
    messages = response.get("messages", []) if isinstance(response.get("messages"), list) else []
    filtered = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        ts = _text(message.get("ts"))
        if oldest and ts and float(ts) <= float(oldest):
            continue
        if thread_id and ts == thread_id:
            continue
        filtered.append(message)
    filtered.sort(key=lambda item: float(_text(item.get("ts")) or 0.0))
    return filtered


def fetch_observed_messages(
    token: str,
    *,
    channel_id: str,
    oldest_root: str = "",
    thread_id: str = "",
    oldest_thread: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    observed: list[dict[str, Any]] = []
    seen: set[str] = set()
    root_messages = fetch_slack_messages(
        token,
        channel_id=channel_id,
        thread_id="",
        oldest=oldest_root,
        limit=limit,
    )
    for message in root_messages:
        ts = _text(message.get("ts"))
        if not ts or ts in seen:
            continue
        seen.add(ts)
        observed.append({**message, "_delivery_scope": "root"})
    if thread_id:
        thread_messages = fetch_slack_messages(
            token,
            channel_id=channel_id,
            thread_id=thread_id,
            oldest=oldest_thread,
            limit=limit,
        )
        for message in thread_messages:
            ts = _text(message.get("ts"))
            if not ts or ts in seen:
                continue
            seen.add(ts)
            observed.append({**message, "_delivery_scope": "thread"})
    observed.sort(key=lambda item: float(_text(item.get("ts")) or 0.0))
    return observed


def message_text(message: dict[str, Any]) -> str:
    text = _text(message.get("text"))
    if text:
        return text
    blocks = message.get("blocks", [])
    if not isinstance(blocks, list):
        return ""
    texts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_text = block.get("text", {})
        if isinstance(block_text, dict):
            value = _text(block_text.get("text"))
            if value:
                texts.append(value)
    return "\n".join(texts).strip()


def evaluate_messages(messages: list[dict[str, Any]], *, started_at: float, ack_deadline_ms: int, final_timeout_s: int) -> dict[str, Any]:
    summary = {
        "message_count": len(messages),
        "ack_seen": False,
        "ack_latency_ms": None,
        "final_seen": False,
        "final_latency_ms": None,
    }
    if not messages:
        return summary
    first_ts = float(_text(messages[0].get("ts")) or 0.0)
    if first_ts > 0:
        ack_latency_ms = int(max(0.0, (first_ts - started_at) * 1000.0))
        summary["ack_latency_ms"] = ack_latency_ms
        summary["ack_seen"] = ack_latency_ms <= max(0, int(ack_deadline_ms))
    last_ts = float(_text(messages[-1].get("ts")) or 0.0)
    if last_ts > 0:
        final_latency_ms = int(max(0.0, (last_ts - started_at) * 1000.0))
        summary["final_latency_ms"] = final_latency_ms
        summary["final_seen"] = final_latency_ms <= max(0, int(final_timeout_s)) * 1000
    return summary


def detect_delivery_mode(process_info: dict[str, Any]) -> str:
    if _text(process_info.get("mode")) == "gateway_rpc":
        return "gateway_rpc"
    stderr = _text(process_info.get("stderr"))
    if "pairing required" in stderr:
        return "gateway_pairing_required"
    if "session file locked" in stderr:
        return "embedded_session_locked"
    if "Gateway agent failed; falling back to embedded" in stderr:
        return "embedded_fallback"
    if process_info.get("returncode") == 0:
        return "gateway_or_session_deliver"
    return "unknown"


def evaluate_content_assertions(messages: list[dict[str, Any]], scenario: dict[str, Any]) -> dict[str, Any]:
    assertions = scenario.get("assertions", {}) if isinstance(scenario.get("assertions"), dict) else {}
    if not assertions:
        return {"passed": True, "checked": False, "failures": []}
    transcript_text = "\n".join(message_text(item) for item in messages if message_text(item)).strip()
    final_text = ""
    for item in reversed(messages):
        text = message_text(item)
        if text:
            final_text = text
            break
    transcript_lower = transcript_text.lower()
    final_lower = final_text.lower()
    failures: list[str] = []

    must_include_any = assertions.get("must_include_any", [])
    if must_include_any and not any(_text(token).lower() in transcript_lower for token in must_include_any):
        failures.append("missing required transcript token")
    final_must_include_any = assertions.get("final_must_include_any", [])
    if final_must_include_any and not any(_text(token).lower() in final_lower for token in final_must_include_any):
        failures.append("missing required final token")
    must_not_include_any = assertions.get("must_not_include_any", [])
    leaked = [_text(token) for token in must_not_include_any if _text(token).lower() in transcript_lower]
    if leaked:
        failures.append(f"unexpected internal tokens: {', '.join(leaked)}")
    return {
        "passed": not failures,
        "checked": True,
        "failures": failures,
        "final_text": final_text,
    }


def run_scenario(
    session: dict[str, Any],
    scenario: dict[str, Any],
    *,
    slack_token: str,
    poll_interval_s: float = 1.0,
    quiet_window_s: float = 4.0,
) -> dict[str, Any]:
    prompt = _text(scenario.get("prompt"))
    scenario_name = _text(scenario.get("name"))
    effective_prompt = build_harness_prompt(scenario_name, prompt)
    ack_deadline_ms = int(scenario.get("ack_deadline_ms", 1500) or 1500)
    final_timeout_s = int(scenario.get("final_timeout_s", 60) or 60)
    channel_id = resolve_channel_id_for_target(slack_token, session.get("target", ""), session.get("native_channel_id", ""))
    if not channel_id:
        return {
            "name": _text(scenario.get("name")),
            "ok": False,
            "error": "unable to resolve slack channel id",
        }
    thread_id = _text(session.get("thread_id"))
    baseline_root = fetch_slack_messages(
        slack_token,
        channel_id=channel_id,
        thread_id="",
        limit=3,
    )
    baseline_thread = fetch_slack_messages(
        slack_token,
        channel_id=channel_id,
        thread_id=thread_id,
        limit=3,
    ) if thread_id else []
    oldest_root = _text(baseline_root[-1].get("ts")) if baseline_root else ""
    oldest_thread = _text(baseline_thread[-1].get("ts")) if baseline_thread else ""
    started_at = time.time()
    launched = launch_agent_turn(session, effective_prompt)
    if not bool(launched.get("ok")):
        return {
            "name": scenario_name,
            "ok": False,
            "error": _text(launched.get("error")) or "openclaw agent launch failed",
            "send_result": launched,
        }
    deadline = started_at + final_timeout_s
    messages: list[dict[str, Any]] = []
    last_new_at = started_at
    while time.time() <= deadline:
        current = fetch_observed_messages(
            slack_token,
            channel_id=channel_id,
            thread_id=thread_id,
            oldest_root=oldest_root,
            oldest_thread=oldest_thread,
            limit=40,
        )
        if current:
            messages = current
            last_new_at = time.time()
        if messages and (time.time() - last_new_at) >= quiet_window_s:
            break
        time.sleep(max(0.2, float(poll_interval_s)))
    process_info: dict[str, Any] = {
        "command": launched.get("command", []),
        "returncode": None,
        "stdout": "",
        "stderr": "",
        "timed_out": False,
        "mode": _text(launched.get("mode")) or ("cli" if launched.get("process") is not None else ""),
    }
    if process_info["mode"] == "cli":
        process = launched["process"]
        try:
            stdout, stderr = process.communicate(timeout=5)
            process_info["returncode"] = process.returncode
            process_info["stdout"] = _text(stdout)
            process_info["stderr"] = _text(stderr)
        except subprocess.TimeoutExpired:
            process_info["timed_out"] = True
            process.kill()
            try:
                stdout, stderr = process.communicate(timeout=5)
            except Exception:
                stdout, stderr = "", ""
            process_info["returncode"] = process.returncode
            process_info["stdout"] = _text(stdout)
            process_info["stderr"] = _text(stderr)
    else:
        process_info["returncode"] = 0 if bool(launched.get("ok")) else 1
        process_info["stdout"] = json.dumps(launched.get("gateway_result", {}), ensure_ascii=False)
    delivery_mode = detect_delivery_mode(process_info)
    evaluation = evaluate_messages(messages, started_at=started_at, ack_deadline_ms=ack_deadline_ms, final_timeout_s=final_timeout_s)
    evaluation["ack_verifiable"] = delivery_mode not in {"embedded_fallback", "gateway_pairing_required", "embedded_session_locked"}
    content_assertions = evaluate_content_assertions(messages, scenario)
    evaluation["content_assertions"] = content_assertions
    transcript = [
        {
            "ts": _text(item.get("ts")),
            "text": message_text(item),
            "user": _text(item.get("user")),
            "bot_id": _text(item.get("bot_id")),
            "subtype": _text(item.get("subtype")),
            "delivery_scope": _text(item.get("_delivery_scope")),
        }
        for item in messages
    ]
    ok = (
        bool(evaluation["final_seen"])
        and bool(transcript)
        and (not evaluation["ack_verifiable"] or bool(evaluation["ack_seen"]))
        and bool(content_assertions.get("passed", True))
    )
    return {
        "name": scenario_name,
        "ok": ok,
        "prompt": prompt,
        "effective_prompt": effective_prompt,
        "session_key": _text(session.get("session_key")),
        "target": _text(session.get("target")),
        "channel_id": channel_id,
        "thread_id": thread_id,
        "delivery_scopes": sorted({item["delivery_scope"] for item in transcript if _text(item.get("delivery_scope"))}),
        "delivery_mode": delivery_mode,
        "send_result": process_info,
        "evaluation": evaluation,
        "messages": transcript,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Slack E2E acceptance scenarios against a live OpenClaw session.")
    parser.add_argument("--openclaw-config", default=default_openclaw_config_path())
    parser.add_argument("--sessions-path", default=default_sessions_path())
    parser.add_argument("--session-key", default="", help="Explicit OpenClaw session key to drive.")
    parser.add_argument("--target", default="", help="Explicit Slack target to match, e.g. channel:C123 or user:U123.")
    parser.add_argument("--native-channel-id", default="", help="Explicit Slack native channel id to match.")
    parser.add_argument("--thread-id", default="", help="Explicit Slack thread id to match.")
    parser.add_argument("--chat-type", default="", choices=["", "direct", "channel"])
    parser.add_argument("--prefer-direct", action="store_true", default=True)
    parser.add_argument("--scenario", action="append", dest="scenarios", default=[], help="Override prompt scenario. Repeatable.")
    parser.add_argument("--preset", choices=sorted(PRESET_SCENARIOS.keys()), default="smoke")
    parser.add_argument("--replay-source", action="append", default=[], help="Optional label=path replay bundle or artifact path.")
    parser.add_argument("--output", default="", help="Optional path to write JSON report.")
    parser.add_argument("--poll-interval-s", type=float, default=1.0)
    parser.add_argument("--quiet-window-s", type=float, default=4.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    slack_cfg = load_slack_config(args.openclaw_config)
    if not slack_cfg.get("enabled") or not slack_cfg.get("bot_token"):
        print(json.dumps({"ok": False, "error": "slack bot token unavailable"}, ensure_ascii=False, indent=2))
        return 2
    session = choose_slack_session(
        args.sessions_path,
        session_key=args.session_key,
        target=args.target,
        native_channel_id=args.native_channel_id,
        thread_id=args.thread_id,
        chat_type=args.chat_type,
        prefer_direct=bool(args.prefer_direct),
        require_native_channel=True,
    )
    if not session:
        print(json.dumps({"ok": False, "error": "no suitable slack session found"}, ensure_ascii=False, indent=2))
        return 2
    scenarios = [{"name": f"custom_{idx+1}", "prompt": prompt} for idx, prompt in enumerate(args.scenarios)] or get_scenarios_for_preset(args.preset)
    results = [
        run_scenario(
            session,
            scenario,
            slack_token=_text(slack_cfg.get("bot_token")),
            poll_interval_s=float(args.poll_interval_s),
            quiet_window_s=float(args.quiet_window_s),
        )
        for scenario in scenarios
    ]
    report = {
        "ok": all(bool(item.get("ok")) for item in results),
        "preset": args.preset,
        "session": session,
        "replay_sources": [inspect_replay_source(item) for item in args.replay_source],
        "results": results,
    }
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
