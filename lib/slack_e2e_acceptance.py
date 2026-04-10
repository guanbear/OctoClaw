#!/usr/bin/env python3
"""Black-box Slack E2E acceptance harness for OctoClaw/OpenClaw sessions."""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    from octopus_config import MAIN_AGENT_SESSIONS_FILE
    from session_ops import send_agent_message
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import MAIN_AGENT_SESSIONS_FILE
    from lib.session_ops import send_agent_message


DEFAULT_OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")

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
    },
]


def _text(value: Any) -> str:
    return str(value or "").strip()


def load_json(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_slack_config(config_path: str = DEFAULT_OPENCLAW_CONFIG) -> dict[str, Any]:
    payload = load_json(config_path)
    channels = payload.get("channels", {}) if isinstance(payload.get("channels"), dict) else {}
    slack = channels.get("slack", {}) if isinstance(channels.get("slack"), dict) else {}
    return {
        "config_path": config_path,
        "enabled": bool(slack.get("enabled")),
        "bot_token": _text(slack.get("botToken")),
        "app_token": _text(slack.get("appToken")),
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
    sessions_path: str = MAIN_AGENT_SESSIONS_FILE,
    *,
    session_key: str = "",
    prefer_direct: bool = True,
    require_native_channel: bool = True,
) -> dict[str, Any]:
    sessions = load_main_sessions(sessions_path)
    entries = []
    for key, value in sessions.items():
        if not isinstance(value, dict):
            continue
        normalized = normalize_session_entry(str(key), value)
        if normalized["provider"] != "slack":
            continue
        if session_key and normalized["session_key"] != session_key:
            continue
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


def run_scenario(
    session: dict[str, Any],
    scenario: dict[str, Any],
    *,
    slack_token: str,
    poll_interval_s: float = 1.0,
    quiet_window_s: float = 4.0,
) -> dict[str, Any]:
    prompt = _text(scenario.get("prompt"))
    ack_deadline_ms = int(scenario.get("ack_deadline_ms", 1500) or 1500)
    final_timeout_s = int(scenario.get("final_timeout_s", 60) or 60)
    channel_id = resolve_channel_id_for_target(slack_token, session.get("target", ""), session.get("native_channel_id", ""))
    if not channel_id:
        return {
            "name": _text(scenario.get("name")),
            "ok": False,
            "error": "unable to resolve slack channel id",
        }
    baseline = fetch_slack_messages(
        slack_token,
        channel_id=channel_id,
        thread_id=_text(session.get("thread_id")),
        limit=3,
    )
    oldest = _text(baseline[-1].get("ts")) if baseline else ""
    started_at = time.time()
    send_result = send_agent_message(_text(session.get("session_key")), prompt, timeout_seconds=0)
    if not bool(send_result.get("ok", True)):
        return {
            "name": _text(scenario.get("name")),
            "ok": False,
            "error": _text(send_result.get("error")) or "send_agent_message failed",
            "send_result": send_result,
        }
    deadline = started_at + final_timeout_s
    messages: list[dict[str, Any]] = []
    last_new_at = started_at
    while time.time() <= deadline:
        current = fetch_slack_messages(
            slack_token,
            channel_id=channel_id,
            thread_id=_text(session.get("thread_id")),
            oldest=oldest,
            limit=40,
        )
        if current:
            messages = current
            last_new_at = time.time()
        if messages and (time.time() - last_new_at) >= quiet_window_s:
            break
        time.sleep(max(0.2, float(poll_interval_s)))
    evaluation = evaluate_messages(messages, started_at=started_at, ack_deadline_ms=ack_deadline_ms, final_timeout_s=final_timeout_s)
    transcript = [
        {
            "ts": _text(item.get("ts")),
            "text": message_text(item),
            "user": _text(item.get("user")),
            "bot_id": _text(item.get("bot_id")),
            "subtype": _text(item.get("subtype")),
        }
        for item in messages
    ]
    ok = bool(evaluation["ack_seen"]) and bool(evaluation["final_seen"]) and bool(transcript)
    return {
        "name": _text(scenario.get("name")),
        "ok": ok,
        "prompt": prompt,
        "session_key": _text(session.get("session_key")),
        "target": _text(session.get("target")),
        "channel_id": channel_id,
        "thread_id": _text(session.get("thread_id")),
        "send_result": send_result,
        "evaluation": evaluation,
        "messages": transcript,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Slack E2E acceptance scenarios against a live OpenClaw session.")
    parser.add_argument("--openclaw-config", default=DEFAULT_OPENCLAW_CONFIG)
    parser.add_argument("--sessions-path", default=MAIN_AGENT_SESSIONS_FILE)
    parser.add_argument("--session-key", default="", help="Explicit OpenClaw session key to drive.")
    parser.add_argument("--prefer-direct", action="store_true", default=True)
    parser.add_argument("--scenario", action="append", dest="scenarios", default=[], help="Override prompt scenario. Repeatable.")
    parser.add_argument("--preset", choices=["smoke"], default="smoke")
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
        prefer_direct=bool(args.prefer_direct),
        require_native_channel=True,
    )
    if not session:
        print(json.dumps({"ok": False, "error": "no suitable slack session found"}, ensure_ascii=False, indent=2))
        return 2
    scenarios = [{"name": f"custom_{idx+1}", "prompt": prompt} for idx, prompt in enumerate(args.scenarios)] or list(SMOKE_SCENARIOS)
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
        "session": session,
        "results": results,
    }
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
