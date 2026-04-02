#!/usr/bin/env python3
"""Append-only checklist history helpers for OctoClaw."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VALID_EVENT_TYPES = {"item_added", "item_done", "item_blocked", "item_reset", "snapshot"}


def _history_path(workspace: str | Path) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "task-checklist-history.jsonl"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _normalize_snapshot(snapshot: dict[str, Any] | None) -> dict[str, Any]:
    payload = snapshot if isinstance(snapshot, dict) else {}
    items = payload.get("items", []) if isinstance(payload.get("items", []), list) else []
    normalized_items: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized_items.append(
            {
                "id": _text(item.get("id")),
                "title": _text(item.get("title")),
                "state": _text(item.get("state")).lower() or "pending",
                "source": _text(item.get("source")),
                "linked_task_id": _text(item.get("linked_task_id")),
            }
        )
    return {
        "kind": _text(payload.get("kind")),
        "items": normalized_items,
        "open_count": int(payload.get("open_count", 0) or 0),
        "completed_count": int(payload.get("completed_count", 0) or 0),
    }


def _snapshot_fingerprint(snapshot: dict[str, Any] | None) -> str:
    normalized = _normalize_snapshot(snapshot)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:16]


def _event_key(payload: dict[str, Any]) -> str:
    stable = {
        "task_id": _text(payload.get("task_id")),
        "event_type": _text(payload.get("event_type")),
        "item_id": _text(payload.get("item_id")),
        "old_state": _text(payload.get("old_state")).lower(),
        "new_state": _text(payload.get("new_state")).lower(),
        "actor": _text(payload.get("actor")),
        "snapshot_fingerprint": _text(payload.get("snapshot_fingerprint")),
        "details": payload.get("details", {}) if isinstance(payload.get("details", {}), dict) else {},
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:20]


def _append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def append_checklist_event(
    task_id: str,
    event_type: str,
    item_id: str,
    old_state: str,
    new_state: str,
    actor: str,
    workspace: str | Path,
    *,
    snapshot: dict[str, Any] | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event_name = _text(event_type)
    if event_name not in VALID_EVENT_TYPES:
        raise ValueError(f"unsupported checklist event type: {event_name}")
    payload: dict[str, Any] = {
        "timestamp": _now_iso(),
        "task_id": _text(task_id),
        "event_type": event_name,
        "item_id": _text(item_id),
        "old_state": _text(old_state).lower(),
        "new_state": _text(new_state).lower(),
        "actor": _text(actor),
    }
    if isinstance(details, dict) and details:
        payload["details"] = details
    if isinstance(snapshot, dict) and snapshot:
        normalized_snapshot = _normalize_snapshot(snapshot)
        payload["snapshot"] = normalized_snapshot
        payload["snapshot_fingerprint"] = _snapshot_fingerprint(snapshot)
    payload["event_key"] = _event_key(payload)

    history = load_checklist_history(_text(task_id), workspace)
    if history and _text(history[-1].get("event_key")) == payload["event_key"]:
        return dict(history[-1])

    _append_jsonl(_history_path(workspace), payload)
    return dict(payload)


def load_checklist_history(task_id: str, workspace: str | Path) -> list[dict[str, Any]]:
    task_key = _text(task_id)
    path = _history_path(workspace)
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict) and _text(payload.get("task_id")) == task_key:
                    events.append(payload)
    except OSError:
        return []
    return events
