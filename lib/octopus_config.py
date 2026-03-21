#!/usr/bin/env python3
"""Shared Octopus config helpers."""

from __future__ import annotations

import json
import os
from typing import Any

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
CONFIG_FILE = f"{WORKSPACE}/tmp/octopus-config.json"
MODE_FILE = f"{WORKSPACE}/tmp/octopus-mode.json"
MODEL_CATALOG_FILE = f"{WORKSPACE}/tmp/octopus/model-catalog.json"
MODEL_POLICY_FILE = f"{WORKSPACE}/tmp/octopus/model-policy.json"
MODEL_SPEED_FILE = f"{WORKSPACE}/tmp/octopus/model-speed.json"
RUNNER_QUEUE_FILE = f"{WORKSPACE}/tmp/octopus/runner-queue.json"
RUNNER_HEALTH_FILE = f"{WORKSPACE}/tmp/octopus/runner-health.json"
RUNNER_RESULTS_DIR = f"{WORKSPACE}/tmp/octopus/runner-results"

SESSIONS_FILE = os.path.expanduser("~/.openclaw/sessions.json")
MAIN_AGENT_SESSIONS_FILE = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")

DEFAULT_CONFIG: dict[str, Any] = {
    "version": "v1.2.0",
    "notification": {
        "backend": "auto",
        "panel_enabled": True,
        "event_enabled": True,
        "text_enabled": True,
    },
    "main_session": {
        "channel": "auto",
        "target": "",
        "session_key": "",
    },
    "model_auto": {
        "enabled": True,
        "prefer_private": False,
        "prefer_low_cost": False,
    },
    "runner": {
        "enabled": True,
        "poll_interval_seconds": 3,
        "heartbeat_interval_seconds": 10,
        "default_timeout_seconds": 120,
        "max_age_minutes": 120,
        "max_jobs_per_worker": 50,
    },
}


def load_json(path: str) -> dict[str, Any] | list[Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def save_json(path: str, data: dict[str, Any] | list[Any]) -> bool:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
        return True
    except OSError:
        return False


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_octopus_config() -> dict[str, Any]:
    data = load_json(CONFIG_FILE)
    if isinstance(data, dict):
        return deep_merge(DEFAULT_CONFIG, data)
    return json.loads(json.dumps(DEFAULT_CONFIG))


def get_notification_backend(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    backend = str(cfg.get("notification", {}).get("backend", "auto") or "auto").lower()
    if backend != "auto":
        return backend
    session_keys = load_session_keys()
    if any(key.startswith("feishu:dm:") for key in session_keys):
        return "feishu"
    return "none"


def notification_enabled(kind: str, config: dict[str, Any] | None = None) -> bool:
    cfg = config or load_octopus_config()
    if get_notification_backend(cfg) == "none":
        return False
    mapping = {
        "panel": "panel_enabled",
        "event": "event_enabled",
        "text": "text_enabled",
    }
    field = mapping.get(kind, f"{kind}_enabled")
    return bool(cfg.get("notification", {}).get(field, False))


def load_session_keys() -> list[str]:
    keys: list[str] = []
    raw = load_json(SESSIONS_FILE)
    if isinstance(raw, dict):
        keys.extend([str(k) for k in raw.keys()])
    main_raw = load_json(MAIN_AGENT_SESSIONS_FILE)
    if isinstance(main_raw, dict):
        for key, value in main_raw.items():
            if isinstance(key, str) and not key.startswith("agent:main:subagent:"):
                keys.append(key)
            elif isinstance(value, dict):
                channel = value.get("channelSessionKey")
                if isinstance(channel, str) and channel:
                    keys.append(channel)
    deduped: list[str] = []
    seen = set()
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped


def resolve_main_session_key(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    main_cfg = cfg.get("main_session", {})
    explicit = str(main_cfg.get("session_key", "") or "").strip()
    if explicit:
        return explicit

    channel = str(main_cfg.get("channel", "auto") or "auto").lower()
    target = str(main_cfg.get("target", "") or "").strip()
    session_keys = load_session_keys()
    if not session_keys:
        return ""

    if target:
        for key in session_keys:
            if target in key:
                return key

    channel_prefixes = {
        "feishu": ["feishu:dm:"],
        "discord": ["discord:"],
        "telegram": ["telegram:"],
        "slack": ["slack:"],
        "auto": ["feishu:dm:", "discord:", "telegram:", "slack:"],
    }
    prefixes = channel_prefixes.get(channel, [f"{channel}:"])
    for prefix in prefixes:
        for key in session_keys:
            if key.startswith(prefix):
                return key

    return session_keys[0]
