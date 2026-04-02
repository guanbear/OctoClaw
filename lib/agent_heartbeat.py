#!/usr/bin/env python3
"""Agent heartbeat storage helpers for OctoClaw."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "octoclaw.agent_heartbeat/v1"


def _heartbeat_path(workspace: str | Path) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "agent-heartbeats.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _parse_iso(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        raw = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def read_heartbeats(workspace: str | Path) -> dict[str, dict[str, Any]]:
    path = _heartbeat_path(workspace)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(agent_id).strip(): dict(record)
        for agent_id, record in payload.items()
        if str(agent_id).strip() and isinstance(record, dict)
    }


def write_heartbeat(agent_id: str, workspace: str | Path) -> dict[str, Any]:
    agent_key = str(agent_id or "").strip()
    if not agent_key:
        raise ValueError("agent_id is required")
    payload = read_heartbeats(workspace)
    record = {
        "last_beat_at": _now_iso(),
        "healthy": True,
        "version": SCHEMA_VERSION,
        "pid": os.getpid(),
    }
    payload[agent_key] = record
    _atomic_write_json(_heartbeat_path(workspace), payload)
    return dict(record)


def is_agent_alive(agent_id: str, workspace: str | Path, stale_after_seconds: int = 60) -> bool:
    agent_key = str(agent_id or "").strip()
    if not agent_key:
        return False
    record = read_heartbeats(workspace).get(agent_key, {})
    if not isinstance(record, dict) or not record:
        return False
    if record.get("healthy") is False:
        return False
    last_beat_at = _parse_iso(str(record.get("last_beat_at", "") or ""))
    if last_beat_at is None:
        return False
    age_seconds = (datetime.now(timezone.utc) - last_beat_at).total_seconds()
    return age_seconds <= max(1, int(stale_after_seconds))
