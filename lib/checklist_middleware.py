#!/usr/bin/env python3
"""Checklist middleware hooks for OctoClaw."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from checklist_history import append_checklist_event, load_checklist_history
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.checklist_history import append_checklist_event, load_checklist_history

try:
    from runtime_coordination import CHECKLIST_STATE_ORDER, TASK_CHECKLIST_STORE_SCHEMA_VERSION, resolve_task_checklist
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_coordination import CHECKLIST_STATE_ORDER, TASK_CHECKLIST_STORE_SCHEMA_VERSION, resolve_task_checklist


COMMAND_PATTERN = re.compile(r"\[(DONE|ADD|BLOCK)\s*:\s*([^\]]+)\]", re.IGNORECASE)


def _checklist_store_path(workspace: str | Path) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "task-checklists.json"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _warn(message: str) -> None:
    print(message, file=sys.stderr)


def _load_store(workspace: str | Path) -> dict[str, Any]:
    path = _checklist_store_path(workspace)
    if not path.exists():
        return {
            "schema_version": TASK_CHECKLIST_STORE_SCHEMA_VERSION,
            "updated_at": "",
            "tasks": {},
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("schema_version", TASK_CHECKLIST_STORE_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("tasks", {})
    if not isinstance(payload.get("tasks"), dict):
        payload["tasks"] = {}
    return payload


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _normalize_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    items = snapshot.get("items", []) if isinstance(snapshot.get("items", []), list) else []
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
                "blocked_reason": _text(item.get("blocked_reason")),
            }
        )
    return {
        "kind": _text(snapshot.get("kind")) or "persisted",
        "items": normalized_items,
        "open_count": int(snapshot.get("open_count", 0) or 0),
        "completed_count": int(snapshot.get("completed_count", 0) or 0),
        "updated_at": _text(snapshot.get("updated_at")),
    }


def _snapshot_signature(snapshot: dict[str, Any]) -> str:
    normalized = _normalize_snapshot(snapshot)
    stable = {
        "kind": normalized.get("kind"),
        "items": [
            {
                "id": item["id"],
                "title": item["title"],
                "state": item["state"],
                "source": item["source"],
                "linked_task_id": item["linked_task_id"],
                "blocked_reason": item["blocked_reason"],
            }
            for item in normalized.get("items", [])
        ],
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def _recount_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    items = snapshot.get("items", []) if isinstance(snapshot.get("items", []), list) else []
    snapshot["open_count"] = sum(1 for item in items if isinstance(item, dict) and _text(item.get("state")).lower() in {"pending", "in_progress", "blocked"})
    snapshot["completed_count"] = sum(1 for item in items if isinstance(item, dict) and _text(item.get("state")).lower() == "done")
    snapshot["updated_at"] = _text(snapshot.get("updated_at")) or _now_iso()
    return snapshot


def _save_snapshot(task_id: str, snapshot: dict[str, Any], workspace: str | Path) -> dict[str, Any]:
    store = _load_store(workspace)
    normalized = _recount_snapshot(_normalize_snapshot(snapshot))
    store["tasks"][_text(task_id)] = normalized
    store["updated_at"] = _now_iso()
    _atomic_write_json(_checklist_store_path(workspace), store)
    return normalized


def _load_snapshot(task_id: str, workspace: str | Path, *, task_record: dict[str, Any] | None = None) -> dict[str, Any]:
    store = _load_store(workspace)
    stored = store.get("tasks", {}).get(_text(task_id), {})
    if isinstance(stored, dict) and stored:
        return _recount_snapshot(_normalize_snapshot(stored))
    if isinstance(task_record, dict) and task_record:
        return _recount_snapshot(_normalize_snapshot(resolve_task_checklist(task_record, path=str(_checklist_store_path(workspace)))))
    return _recount_snapshot(_normalize_snapshot(resolve_task_checklist(task_id, path=str(_checklist_store_path(workspace)))))


def _find_item(snapshot: dict[str, Any], item_id: str) -> dict[str, Any] | None:
    needle = _text(item_id)
    items = snapshot.get("items", []) if isinstance(snapshot.get("items", []), list) else []
    for item in items:
        if isinstance(item, dict) and _text(item.get("id")) == needle:
            return item
    return None


def _find_item_by_title(snapshot: dict[str, Any], title: str) -> dict[str, Any] | None:
    needle = _text(title).casefold()
    items = snapshot.get("items", []) if isinstance(snapshot.get("items", []), list) else []
    for item in items:
        if isinstance(item, dict) and _text(item.get("title")).casefold() == needle:
            return item
    return None


def _slugify_title(title: str, snapshot: dict[str, Any]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", _text(title).lower()).strip("-") or "item"
    existing_ids = {
        _text(item.get("id"))
        for item in snapshot.get("items", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    candidate = base
    index = 2
    while candidate in existing_ids:
        candidate = f"{base}-{index}"
        index += 1
    return candidate


def _latest_snapshot_fingerprint(task_id: str, workspace: str | Path) -> str:
    history = load_checklist_history(task_id, workspace)
    for event in reversed(history):
        if _text(event.get("event_type")) == "snapshot":
            return _text(event.get("snapshot_fingerprint"))
    return ""


def _append_snapshot_if_changed(task_id: str, snapshot: dict[str, Any], actor: str, workspace: str | Path, *, details: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = _recount_snapshot(_normalize_snapshot(snapshot))
    before = _latest_snapshot_fingerprint(task_id, workspace)
    saved = _save_snapshot(task_id, normalized, workspace)
    if before == _text(append_checklist_event(task_id, "snapshot", "", "", "", actor, workspace, snapshot=saved, details=details).get("snapshot_fingerprint")):
        return saved
    return saved


def on_task_dispatch(task_record: dict[str, Any], workspace: str | Path) -> dict[str, Any]:
    task_id = _text((task_record or {}).get("id"))
    if not task_id:
        return {}
    snapshot = _load_snapshot(task_id, workspace, task_record=task_record)
    current = _load_snapshot(task_id, workspace)
    if _latest_snapshot_fingerprint(task_id, workspace) and _snapshot_signature(current) == _snapshot_signature(snapshot):
        return current
    return _append_snapshot_if_changed(task_id, snapshot, "task_dispatch", workspace)


def on_agent_message(task_id: str, message_text: str, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {"task_id": "", "applied": 0, "snapshot": {}}
    snapshot = _load_snapshot(task_key, workspace)
    before_signature = _snapshot_signature(snapshot)
    applied = 0

    try:
        matches = list(COMMAND_PATTERN.finditer(str(message_text or "")))
    except re.error as exc:  # pragma: no cover - defensive only
        _warn(f"warning: checklist regex failed for task {task_key}: {exc}")
        matches = []

    if not matches:
        return {"task_id": task_key, "applied": 0, "snapshot": snapshot}

    for match in matches:
        command = _text(match.group(1)).upper()
        body = _text(match.group(2))
        if not body:
            _warn(f"warning: empty checklist command for task {task_key}")
            continue
        if command == "DONE":
            item = _find_item(snapshot, body)
            if item is None:
                _warn(f"warning: checklist item {body!r} not found for task {task_key}")
                continue
            old_state = _text(item.get("state")).lower() or "pending"
            if old_state == "done":
                continue
            item["state"] = "done"
            item["updated_at"] = _now_iso()
            append_checklist_event(task_key, "item_done", _text(item.get("id")), old_state, "done", "agent_message", workspace, details={"title": _text(item.get("title"))})
            applied += 1
            continue
        if command == "ADD":
            existing = _find_item_by_title(snapshot, body)
            if existing is not None:
                continue
            item_id = _slugify_title(body, snapshot)
            items = snapshot.get("items", [])
            if not isinstance(items, list):
                items = []
                snapshot["items"] = items
            items.append(
                {
                    "id": item_id,
                    "title": body,
                    "state": "pending",
                    "source": "middleware",
                    "linked_task_id": "",
                    "blocked_reason": "",
                    "updated_at": _now_iso(),
                }
            )
            append_checklist_event(task_key, "item_added", item_id, "", "pending", "agent_message", workspace, details={"title": body})
            applied += 1
            continue
        if command == "BLOCK":
            parts = body.split(None, 1)
            item_id = _text(parts[0] if parts else "")
            reason = _text(parts[1] if len(parts) > 1 else "")
            if not item_id:
                _warn(f"warning: invalid BLOCK command for task {task_key}: {body!r}")
                continue
            item = _find_item(snapshot, item_id)
            if item is None:
                _warn(f"warning: checklist item {item_id!r} not found for task {task_key}")
                continue
            old_state = _text(item.get("state")).lower() or "pending"
            old_reason = _text(item.get("blocked_reason"))
            if old_state == "blocked" and old_reason == reason:
                continue
            item["state"] = "blocked"
            item["blocked_reason"] = reason
            item["updated_at"] = _now_iso()
            append_checklist_event(task_key, "item_blocked", item_id, old_state, "blocked", "agent_message", workspace, details={"reason": reason, "title": _text(item.get("title"))})
            applied += 1
            continue

    snapshot = _recount_snapshot(snapshot)
    if before_signature != _snapshot_signature(snapshot):
        snapshot = _append_snapshot_if_changed(task_key, snapshot, "agent_message", workspace)
    return {"task_id": task_key, "applied": applied, "snapshot": snapshot}


def on_task_error(task_id: str, error_info: Any, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {}
    snapshot = _load_snapshot(task_key, workspace)
    details = {"error_info": error_info} if error_info not in (None, "", [], {}) else None
    return _append_snapshot_if_changed(task_key, snapshot, "task_error", workspace, details=details)


def _merge_snapshots(current: dict[str, Any], recovered: dict[str, Any]) -> dict[str, Any]:
    current_snapshot = _recount_snapshot(_normalize_snapshot(current))
    recovered_snapshot = _recount_snapshot(_normalize_snapshot(recovered))
    recovered_by_id = {
        _text(item.get("id")): item
        for item in recovered_snapshot.get("items", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    merged_items: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in current_snapshot.get("items", []):
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        merged = dict(item)
        recovered_item = recovered_by_id.get(item_id, {})
        if isinstance(recovered_item, dict) and recovered_item:
            current_state = _text(merged.get("state")).lower() or "pending"
            recovered_state = _text(recovered_item.get("state")).lower() or "pending"
            merged["state"] = current_state if CHECKLIST_STATE_ORDER.get(current_state, 0) >= CHECKLIST_STATE_ORDER.get(recovered_state, 0) else recovered_state
            if not _text(merged.get("title")):
                merged["title"] = _text(recovered_item.get("title"))
            if not _text(merged.get("source")):
                merged["source"] = _text(recovered_item.get("source"))
            if not _text(merged.get("linked_task_id")):
                merged["linked_task_id"] = _text(recovered_item.get("linked_task_id"))
            if not _text(merged.get("blocked_reason")):
                merged["blocked_reason"] = _text(recovered_item.get("blocked_reason"))
        merged_items.append(merged)
        if item_id:
            seen.add(item_id)

    for item in recovered_snapshot.get("items", []):
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        if item_id and item_id in seen:
            continue
        merged_items.append(dict(item))

    return _recount_snapshot(
        {
            "kind": _text(current_snapshot.get("kind")) or _text(recovered_snapshot.get("kind")) or "persisted",
            "items": merged_items,
            "updated_at": _now_iso(),
        }
    )


def on_task_recovery(task_id: str, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {}
    history = load_checklist_history(task_key, workspace)
    recovered_snapshot = {}
    for event in reversed(history):
        if _text(event.get("event_type")) == "snapshot" and isinstance(event.get("snapshot"), dict):
            recovered_snapshot = dict(event.get("snapshot"))
            break
    current = _load_snapshot(task_key, workspace)
    if not recovered_snapshot:
        return _recount_snapshot(_normalize_snapshot(current))
    merged = _merge_snapshots(current, recovered_snapshot)
    if _snapshot_signature(current) == _snapshot_signature(merged):
        return _recount_snapshot(_normalize_snapshot(current))
    return _append_snapshot_if_changed(task_key, merged, "task_recovery", workspace)
