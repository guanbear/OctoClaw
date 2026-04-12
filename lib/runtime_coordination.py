#!/usr/bin/env python3
"""Shared runtime coordination surfaces for OctoClaw."""

from __future__ import annotations

import fcntl
import json
import os
import re
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from octopus_config import WORKSPACE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import WORKSPACE

try:
    from task_events import register_session_binding
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_events import register_session_binding

ARTIFACT_INDEX_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "artifact-index.json")
OWNERSHIP_STORE_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "task-ownership.json")
WORKER_SESSION_STORE_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "worker-session-store.json")
TASK_CHECKLIST_STORE_FILE = os.path.join(WORKSPACE, "tmp", "octopus", "task-checklists.json")

ARTIFACT_INDEX_SCHEMA_VERSION = "octoclaw.artifact_index/v1"
OWNERSHIP_STORE_SCHEMA_VERSION = "octoclaw.task_ownership/v1"
WORKER_SESSION_STORE_SCHEMA_VERSION = "octoclaw.worker_session_store/v1"
TASK_CHECKLIST_STORE_SCHEMA_VERSION = "octoclaw.task_checklists/v1"

FINAL_LIFECYCLE_STATES = {"finished", "cancelled"}
OPEN_CHECKLIST_STATES = {"pending", "in_progress", "blocked"}
CHECKLIST_STATE_ORDER = {
    "pending": 0,
    "in_progress": 1,
    "blocked": 2,
    "done": 3,
    "failed": 4,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _ensure_parent(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def _load_json(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_json(path: str, payload: dict[str, Any]) -> None:
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def _workspace_for_store(path: str) -> Path:
    store_path = Path(path)
    if len(store_path.parents) >= 3:
        return store_path.parents[2]
    return Path(WORKSPACE)


def _parse_iso(value: str) -> datetime | None:
    raw = _text(value)
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _iso_plus_seconds(value: str, seconds: int) -> str:
    parsed = _parse_iso(value)
    if parsed is None:
        parsed = datetime.now(timezone.utc)
    return (parsed + timedelta(seconds=max(0, int(seconds)))).astimezone().isoformat()


def _append_unique(items: list[str], value: str) -> list[str]:
    text = _text(value)
    if not text:
        return items
    if text not in items:
        items.append(text)
    return items


def _preview_text(value: Any, limit: int = 160) -> str:
    text = " ".join(_text(value).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _artifact_id(task_id: str, kind: str, key: str) -> str:
    raw = f"{_text(task_id)}:{_text(kind)}:{_text(key)}"
    return re.sub(r"[^a-zA-Z0-9._:-]+", "-", raw).strip("-")[:180]


def ownership_snapshot(task: dict[str, Any], *, lease_seconds: int = 900) -> dict[str, Any]:
    task_id = _text(task.get("id"))
    owner_id = _text(task.get("owner")) or _text(task.get("agent_id"))
    owner_namespace = _text(task.get("agent_namespace")) or ("octoclaw" if owner_id else "")
    session_id = _text(task.get("session_id"))
    run_id = _text(task.get("run_id"))
    lifecycle_state = _text(task.get("lifecycle_state")).lower()
    session_status = _text(task.get("session_status")).lower()
    recovery_action = _text(task.get("recovery_action")).lower()
    claimed_at = _text(task.get("started_at")) or _text(task.get("spawned_at")) or _text(task.get("updated_at"))
    last_heartbeat_at = _text(task.get("last_observed_at")) or _text(task.get("updated_at")) or claimed_at

    if lifecycle_state in FINAL_LIFECYCLE_STATES:
        state = "released"
    elif recovery_action == "dead_agent_recovered":
        state = "recovered"
    elif owner_id or session_id or run_id:
        if session_status in {"missing", "timeout", "stale", "lost"}:
            state = "stale"
        else:
            state = "claimed"
    else:
        state = "unclaimed"

    return {
        "task_id": task_id,
        "owner_id": owner_id,
        "owner_namespace": owner_namespace,
        "owner_session_id": session_id,
        "run_id": run_id,
        "state": state,
        "claimed_at": claimed_at,
        "last_heartbeat_at": last_heartbeat_at,
        "lease_seconds": max(60, int(lease_seconds)),
        "lease_expires_at": _iso_plus_seconds(last_heartbeat_at or now_iso(), max(60, int(lease_seconds))) if state == "claimed" else "",
    }


def session_resume_snapshot(task: dict[str, Any]) -> dict[str, Any]:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    spawn_execution = artifacts.get("spawn_execution", {}) if isinstance(artifacts.get("spawn_execution", {}), dict) else {}
    task_id = _text(task.get("id"))
    agent_id = _text(task.get("agent_id")) or _text(task.get("owner"))
    agent_namespace = _text(task.get("agent_namespace")) or ("octoclaw" if agent_id else "")
    session_key = _text(task.get("session_key")) or _text(spawn_execution.get("child_session_key")) or _text(spawn_execution.get("session_key"))
    session_id = _text(spawn_execution.get("session_id")) or _text(task.get("session_id"))
    run_id = _text(spawn_execution.get("run_id")) or _text(task.get("run_id"))
    session_status = _text(task.get("session_status")).lower()
    lifecycle_state = _text(task.get("lifecycle_state")).lower()
    recovery_action = _text(task.get("recovery_action")).lower()
    last_observed_at = _text(task.get("last_observed_at")) or _text(task.get("updated_at"))

    if lifecycle_state in FINAL_LIFECYCLE_STATES:
        resume_state = "complete"
    elif recovery_action == "dead_agent_recovered":
        resume_state = "recovered"
    elif session_status in {"missing", "timeout", "stale", "lost"}:
        resume_state = "stale"
    elif session_id or run_id:
        resume_state = "active"
    else:
        resume_state = "none"

    resume_key = ""
    if agent_namespace and agent_id and (session_id or run_id):
        resume_key = f"{agent_namespace}:{agent_id}:{session_id or run_id}"
    elif session_key:
        resume_key = f"session:{session_key}"
    elif task_id:
        resume_key = f"task:{task_id}"

    return {
        "task_id": task_id,
        "resume_key": resume_key,
        "agent_id": agent_id,
        "agent_namespace": agent_namespace,
        "session_key": session_key,
        "session_id": session_id,
        "run_id": run_id,
        "session_status": session_status,
        "resume_state": resume_state,
        "last_observed_at": last_observed_at,
    }


def _generic_checklist_items(task: dict[str, Any]) -> list[dict[str, Any]]:
    lifecycle_state = _text(task.get("lifecycle_state")).lower()
    handoff_state = _text(task.get("handoff_state")).lower()
    outcome_state = _text(task.get("outcome_state")).lower()
    has_result = bool(_text(task.get("report_path")) or _text((task.get("artifacts", {}) or {}).get("report_path")) or isinstance((task.get("artifacts", {}) or {}).get("worker_result"), dict))

    dispatch_state = "done" if lifecycle_state in {"running", "finalizing", "finished", "cancelled"} else "pending"
    execute_state = "done" if lifecycle_state in FINAL_LIFECYCLE_STATES else ("in_progress" if lifecycle_state in {"running", "finalizing"} else "pending")
    report_state = "done" if has_result else ("failed" if outcome_state == "failed" else ("blocked" if outcome_state == "blocked" else "pending"))
    handoff_item_state = "done" if handoff_state in {"user_safe_ready", "delivered"} else ("blocked" if outcome_state == "blocked" else "pending")
    return [
        {"id": "dispatch", "title": "Dispatch delegated work", "state": dispatch_state, "source": "default"},
        {"id": "execute", "title": "Execute delegated work", "state": execute_state, "source": "default"},
        {"id": "report", "title": "Persist report or result", "state": report_state, "source": "default"},
        {"id": "handoff", "title": "Prepare user-safe handoff", "state": handoff_item_state, "source": "default"},
    ]


def _team_parent_checklist_items(task: dict[str, Any]) -> list[dict[str, Any]]:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    step_order = artifacts.get("step_order", []) if isinstance(artifacts.get("step_order", []), list) else []
    step_statuses = artifacts.get("step_statuses", {}) if isinstance(artifacts.get("step_statuses", {}), dict) else {}
    step_task_ids = artifacts.get("step_task_ids", {}) if isinstance(artifacts.get("step_task_ids", {}), dict) else {}
    items: list[dict[str, Any]] = []
    for step in step_order:
        name = _text(step)
        if not name:
            continue
        raw_status = _text(step_statuses.get(name)).lower()
        state = {
            "done": "done",
            "running": "in_progress",
            "queued": "pending",
            "blocked": "blocked",
            "failed": "failed",
        }.get(raw_status, "pending")
        items.append(
            {
                "id": name,
                "title": f"{name} step",
                "state": state,
                "source": "team_parent",
                "linked_task_id": _text(step_task_ids.get(name)),
            }
        )
    return items


def checklist_snapshot(task: dict[str, Any]) -> dict[str, Any]:
    explicit = task.get("checklist")
    explicit_kind = _text((explicit or {}).get("kind")) if isinstance(explicit, dict) else ""
    if isinstance(explicit, dict) and explicit_kind in {"explicit", "artifact"}:
        items = explicit.get("items", []) if isinstance(explicit.get("items", []), list) else []
        kind = explicit_kind or "explicit"
    else:
        artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
        artifact_checklist = artifacts.get("checklist")
        if isinstance(artifact_checklist, dict):
            items = artifact_checklist.get("items", []) if isinstance(artifact_checklist.get("items", []), list) else []
            kind = _text(artifact_checklist.get("kind")) or "artifact"
        elif _text(task.get("task_kind")) == "team_parent":
            items = _team_parent_checklist_items(task)
            kind = "team_parent"
        else:
            items = _generic_checklist_items(task)
            kind = "delegated_default"

    normalized_items: list[dict[str, Any]] = []
    completed_count = 0
    open_count = 0
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        state = _text(item.get("state")).lower()
        if state not in {"pending", "in_progress", "done", "blocked", "failed"}:
            state = "pending"
        if state == "done":
            completed_count += 1
        if state in OPEN_CHECKLIST_STATES:
            open_count += 1
        normalized_items.append(
            {
                "id": _text(item.get("id")) or f"item-{idx+1}",
                "title": _text(item.get("title")) or f"Checklist item {idx+1}",
                "state": state,
                "source": _text(item.get("source")) or kind,
                "linked_task_id": _text(item.get("linked_task_id")),
                "updated_at": _text(item.get("updated_at")) or _text(task.get("updated_at")) or now_iso(),
            }
        )
    return {
        "kind": kind,
        "items": normalized_items,
        "open_count": open_count,
        "completed_count": completed_count,
        "updated_at": _text(task.get("updated_at")) or now_iso(),
    }


def _merge_checklist_state(base_state: str, persisted_state: str) -> str:
    base = _text(base_state).lower() or "pending"
    persisted = _text(persisted_state).lower() or "pending"
    return base if CHECKLIST_STATE_ORDER.get(base, 0) >= CHECKLIST_STATE_ORDER.get(persisted, 0) else persisted


def _title_key(item: dict[str, Any]) -> str:
    """Normalised title for fuzzy matching when item IDs have diverged."""
    return " ".join(_text(item.get("title")).lower().split())


def _checklist_conflict_type(
    base_items: list[dict[str, Any]],
    persisted_items: list[dict[str, Any]],
) -> str:
    """Classify the merge situation.

    Returns:
      'trivial'  — one or both sides empty; nothing complex to resolve
      'stable'   — majority of base IDs found in persisted; use ID-based merge
      'diverged' — IDs mostly don't match (context loss / checklist regeneration)
    """
    if not base_items or not persisted_items:
        return "trivial"
    base_ids = {_text(i.get("id")) for i in base_items if isinstance(i, dict) and _text(i.get("id"))}
    persisted_ids = {_text(i.get("id")) for i in persisted_items if isinstance(i, dict) and _text(i.get("id"))}
    if not base_ids or not persisted_ids:
        return "trivial"
    overlap = base_ids & persisted_ids
    # Fewer than half of base IDs match → assume context loss regenerated new IDs
    return "stable" if len(overlap) >= len(base_ids) * 0.5 else "diverged"


def _merge_checklist_items_diverged(
    base_items: list[dict[str, Any]],
    persisted_items: list[dict[str, Any]],
    *,
    include_persisted_only: bool = True,
) -> list[dict[str, Any]]:
    """Merge when item IDs have diverged (context loss / checklist regeneration).

    Strategy:
    - Match base items → persisted items by normalised title (first match wins).
    - For matched pairs: take max state order.
    - For unmatched persisted items: include only if state == 'done' (they
      represent completed work, not phantom pending/blocked items).
    - For unmatched base items: keep as-is.
    """
    persisted_by_title: dict[str, dict[str, Any]] = {}
    merged: list[dict[str, Any]] = []

    for item in persisted_items:
        if not isinstance(item, dict):
            continue
        key = _title_key(item)
        if key and key not in persisted_by_title:
            persisted_by_title[key] = item

    matched_titles: set[str] = set()

    for item in base_items:
        if not isinstance(item, dict):
            continue
        key = _title_key(item)
        persisted = persisted_by_title.get(key, {}) if key else {}
        merged_item = dict(item)
        if persisted:
            merged_item["state"] = _merge_checklist_state(merged_item.get("state", ""), persisted.get("state", ""))
            if not _text(merged_item.get("linked_task_id")):
                merged_item["linked_task_id"] = _text(persisted.get("linked_task_id"))
            matched_titles.add(key)
        merged.append(merged_item)

    if not include_persisted_only:
        return merged

    # Include persisted-only items whose work is done — genuine completed steps
    for item in persisted_items:
        if not isinstance(item, dict):
            continue
        key = _title_key(item)
        if key and key in matched_titles:
            continue
        if _text(item.get("state")).lower() != "done":
            continue  # drop phantom pending/blocked items; they are likely stale
        merged.append({
            "id": _text(item.get("id")) or f"persisted-done-{len(merged) + 1}",
            "title": _text(item.get("title")) or "Completed item",
            "state": "done",
            "source": _text(item.get("source")) or "persisted",
            "linked_task_id": _text(item.get("linked_task_id")),
            "updated_at": _text(item.get("updated_at")) or now_iso(),
        })

    return merged


def _recount_checklist(snapshot: dict[str, Any]) -> dict[str, Any]:
    items = snapshot.get("items", []) if isinstance(snapshot.get("items"), list) else []
    open_count = sum(1 for item in items if isinstance(item, dict) and _text(item.get("state")).lower() in OPEN_CHECKLIST_STATES)
    completed_count = sum(1 for item in items if isinstance(item, dict) and _text(item.get("state")).lower() == "done")
    snapshot["open_count"] = open_count
    snapshot["completed_count"] = completed_count
    return snapshot


def _normalized_checklist_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    items = snapshot.get("items", []) if isinstance(snapshot.get("items"), list) else []
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
        "kind": _text(snapshot.get("kind")),
        "items": normalized_items,
    }


def _checklist_signature(snapshot: dict[str, Any]) -> str:
    return json.dumps(_normalized_checklist_snapshot(snapshot), ensure_ascii=False, sort_keys=True)


def _checklist_items_by_id(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    items = snapshot.get("items", []) if isinstance(snapshot.get("items"), list) else []
    return {
        _text(item.get("id")): item
        for item in items
        if isinstance(item, dict) and _text(item.get("id"))
    }


def _append_checklist_history_if_changed(task: dict[str, Any], previous: dict[str, Any], current: dict[str, Any], *, actor: str = "runtime_sync") -> None:
    task_id = _text(task.get("id"))
    if not task_id or _checklist_signature(previous) == _checklist_signature(current):
        return
    try:
        from checklist_history import append_checklist_event
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.checklist_history import append_checklist_event

    workspace = str(_workspace_for_store(TASK_CHECKLIST_STORE_FILE))
    previous_items = _checklist_items_by_id(previous)
    current_items = _checklist_items_by_id(current)

    for item_id, item in current_items.items():
        current_state = _text(item.get("state")).lower() or "pending"
        previous_item = previous_items.get(item_id)
        if previous_item is None:
            append_checklist_event(
                task_id,
                "item_added",
                item_id,
                "",
                current_state,
                actor,
                workspace,
                details={
                    "title": _text(item.get("title")),
                    "source": _text(item.get("source")),
                    "linked_task_id": _text(item.get("linked_task_id")),
                },
            )
            continue
        previous_state = _text(previous_item.get("state")).lower() or "pending"
        if previous_state == current_state:
            continue
        event_type = "item_done" if current_state == "done" else ("item_blocked" if current_state == "blocked" else "item_reset")
        append_checklist_event(
            task_id,
            event_type,
            item_id,
            previous_state,
            current_state,
            actor,
            workspace,
            details={
                "title": _text(item.get("title")),
                "source": _text(item.get("source")),
                "linked_task_id": _text(item.get("linked_task_id")),
            },
        )

    append_checklist_event(
        task_id,
        "snapshot",
        "",
        "",
        "",
        actor,
        workspace,
        snapshot=current,
    )


def _merge_checklist_items(
    base_items: list[dict[str, Any]],
    persisted_items: list[dict[str, Any]],
    *,
    include_persisted_only: bool = True,
) -> list[dict[str, Any]]:
    # When item IDs have diverged (context loss / checklist regeneration), use
    # title-based matching with conservative phantom-item filtering.
    if _checklist_conflict_type(base_items, persisted_items) == "diverged":
        return _merge_checklist_items_diverged(
            base_items,
            persisted_items,
            include_persisted_only=include_persisted_only,
        )
    merged: list[dict[str, Any]] = []
    persisted_by_id = {
        _text(item.get("id")): item
        for item in persisted_items
        if isinstance(item, dict) and _text(item.get("id"))
    }
    seen: set[str] = set()

    for item in base_items:
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        persisted = persisted_by_id.get(item_id, {})
        merged_item = dict(item)
        if isinstance(persisted, dict) and persisted:
            merged_item["state"] = _merge_checklist_state(merged_item.get("state", ""), persisted.get("state", ""))
            merged_item["updated_at"] = _text(merged_item.get("updated_at")) or _text(persisted.get("updated_at")) or now_iso()
            if not _text(merged_item.get("title")):
                merged_item["title"] = _text(persisted.get("title"))
            if not _text(merged_item.get("source")):
                merged_item["source"] = _text(persisted.get("source"))
            if not _text(merged_item.get("linked_task_id")):
                merged_item["linked_task_id"] = _text(persisted.get("linked_task_id"))
        merged.append(merged_item)
        if item_id:
            seen.add(item_id)

    if not include_persisted_only:
        return merged

    for item in persisted_items:
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        if item_id and item_id in seen:
            continue
        merged.append(
            {
                "id": item_id or f"persisted-{len(merged)+1}",
                "title": _text(item.get("title")) or item_id or "Checklist item",
                "state": _text(item.get("state")).lower() or "pending",
                "source": _text(item.get("source")) or "persisted",
                "linked_task_id": _text(item.get("linked_task_id")),
                "updated_at": _text(item.get("updated_at")) or now_iso(),
            }
        )
    return merged


def artifact_entries_for_task(task: dict[str, Any]) -> list[dict[str, Any]]:
    task_id = _text(task.get("id"))
    parent_id = _text(task.get("parent_id"))
    worker_pool = _text(task.get("worker_pool"))
    phase = _text(task.get("phase"))
    status = _text(task.get("status"))
    session_thread_key = _text(task.get("session_thread_key"))
    updated_at = _text(task.get("updated_at")) or now_iso()
    title = _text(task.get("title")) or _text(task.get("task_description")) or task_id
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    entries: list[dict[str, Any]] = []

    def add(kind: str, key: str, *, path: str = "", preview: str = "", title_suffix: str = "", extra: dict[str, Any] | None = None) -> None:
        artifact_id = _artifact_id(task_id, kind, key or preview or title)
        payload = {
            "artifact_id": artifact_id,
            "task_id": task_id,
            "parent_id": parent_id,
            "kind": kind,
            "title": f"{title}{title_suffix}",
            "path": _text(path),
            "preview": _preview_text(preview),
            "worker_pool": worker_pool,
            "phase": phase,
            "status": status,
            "session_thread_key": session_thread_key,
            "updated_at": updated_at,
        }
        if isinstance(extra, dict):
            payload.update({k: v for k, v in extra.items() if v not in (None, "", [], {})})
        entries.append(payload)

    report_path = _text(task.get("report_path")) or _text(artifacts.get("report_path"))
    if report_path:
        add("report", report_path, path=report_path, preview=_text(task.get("summary")) or _text(task.get("user_safe_summary")))
    context_path = _text(task.get("context_path")) or _text(artifacts.get("context_path"))
    if context_path:
        add("context", context_path, path=context_path, preview=_text(artifacts.get("context_summary")) or _text(task.get("context_summary")))
    context_pack_path = _text(artifacts.get("context_pack_path"))
    if context_pack_path:
        add("context_pack", context_pack_path, path=context_pack_path, preview=_text(artifacts.get("context_summary")) or _text(task.get("context_summary")), title_suffix=" · context pack")
    worker_result = artifacts.get("worker_result") if isinstance(artifacts.get("worker_result"), dict) else {}
    if worker_result:
        add(
            "worker_result",
            _text(worker_result.get("task_id")) or task_id,
            path=_text(worker_result.get("report")),
            preview=_text(worker_result.get("summary")),
            extra={"result_status": _text(worker_result.get("status"))},
        )
    files_changed = artifacts.get("files_changed", [])
    if isinstance(files_changed, list):
        for path in files_changed:
            file_path = _text(path)
            if file_path:
                add("file_change", file_path, path=file_path, preview=file_path, title_suffix=" · file")
    child_results = artifacts.get("child_worker_results", {})
    if isinstance(child_results, dict):
        for child_id, result in child_results.items():
            if not isinstance(result, dict):
                continue
            add(
                "child_result",
                _text(child_id),
                path=_text(result.get("report")),
                preview=_text(result.get("summary")),
                title_suffix=f" · {_text(child_id)}",
                extra={"result_status": _text(result.get("status"))},
            )
    budget_artifact = artifacts.get("budget") if isinstance(artifacts.get("budget"), dict) else {}
    if budget_artifact:
        add(
            "budget",
            _text(budget_artifact.get("recorded_at")) or task_id,
            preview=f"${budget_artifact.get('cost_usd', 0.0)} · {_text(budget_artifact.get('model_band'))} · {_text(budget_artifact.get('worker_pool'))}",
            title_suffix=" · budget",
            extra={"cost_usd": budget_artifact.get("cost_usd")},
        )
    return entries


def load_artifact_index(path: str = ARTIFACT_INDEX_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", ARTIFACT_INDEX_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("artifacts", {})
    payload.setdefault("task_index", {})
    payload.setdefault("thread_index", {})
    return payload


def load_ownership_store(path: str = OWNERSHIP_STORE_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", OWNERSHIP_STORE_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("tasks", {})
    return payload


def load_worker_session_store(path: str = WORKER_SESSION_STORE_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", WORKER_SESSION_STORE_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("sessions", {})
    payload.setdefault("task_index", {})
    return payload


def list_worker_sessions(*, task_id: str = "", path: str = WORKER_SESSION_STORE_FILE) -> list[dict[str, Any]]:
    payload = load_worker_session_store(path)
    sessions = payload.get("sessions", {}) if isinstance(payload.get("sessions", {}), dict) else {}
    task_index = payload.get("task_index", {}) if isinstance(payload.get("task_index", {}), dict) else {}
    keys: list[str] = []
    if task_id:
        items = task_index.get(task_id, [])
        if isinstance(items, list):
            keys.extend(_text(item) for item in items if _text(item))
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key in keys:
        if key in seen:
            continue
        seen.add(key)
        entry = sessions.get(key)
        if isinstance(entry, dict):
            results.append(dict(entry))
    results.sort(key=lambda item: _text(item.get("last_observed_at")), reverse=True)
    return results


def resolve_worker_session(task: dict[str, Any] | str, *, path: str = WORKER_SESSION_STORE_FILE) -> dict[str, Any]:
    task_id = _text(task.get("id")) if isinstance(task, dict) else _text(task)
    if not task_id:
        return {}
    sessions = list_worker_sessions(task_id=task_id, path=path)
    return sessions[0] if sessions else {}


def load_task_checklists(path: str = TASK_CHECKLIST_STORE_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", TASK_CHECKLIST_STORE_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("tasks", {})
    return payload


def resolve_task_checklist(task: dict[str, Any] | str, *, path: str = TASK_CHECKLIST_STORE_FILE) -> dict[str, Any]:
    if isinstance(task, dict):
        task_id = _text(task.get("id"))
        base = checklist_snapshot(task)
    else:
        task_id = _text(task)
        base = {"kind": "persisted", "items": [], "open_count": 0, "completed_count": 0, "updated_at": ""}
    if not task_id:
        return _recount_checklist(base)

    payload = load_task_checklists(path)
    persisted = payload.get("tasks", {}).get(task_id, {}) if isinstance(payload.get("tasks", {}), dict) else {}
    if not isinstance(persisted, dict) or not persisted:
        return _recount_checklist(base)

    persisted_items = persisted.get("items", []) if isinstance(persisted.get("items", []), list) else []
    base_items = base.get("items", []) if isinstance(base.get("items", []), list) else []
    base_kind = _text(base.get("kind")).lower()
    merged = {
        "kind": _text(base.get("kind")) or _text(persisted.get("kind")) or "persisted",
        "items": _merge_checklist_items(
            base_items,
            persisted_items,
            include_persisted_only=base_kind not in {"explicit", "artifact"},
        ),
        "updated_at": _text(base.get("updated_at")) or _text(persisted.get("updated_at")) or now_iso(),
    }
    return _recount_checklist(merged)


def upsert_artifact_index(task: dict[str, Any], *, path: str = ARTIFACT_INDEX_FILE) -> dict[str, Any]:
    payload = load_artifact_index(path)
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts", {}), dict) else {}
    task_index = payload.get("task_index", {}) if isinstance(payload.get("task_index", {}), dict) else {}
    thread_index = payload.get("thread_index", {}) if isinstance(payload.get("thread_index", {}), dict) else {}
    task_id = _text(task.get("id"))
    entries = artifact_entries_for_task(task)
    task_artifact_ids: list[str] = []
    for entry in entries:
        artifact_id = _text(entry.get("artifact_id"))
        if not artifact_id:
            continue
        artifacts[artifact_id] = entry
        task_artifact_ids = _append_unique(task_artifact_ids, artifact_id)
        thread_key = _text(entry.get("session_thread_key"))
        if thread_key:
            bucket = thread_index.get(thread_key, [])
            if not isinstance(bucket, list):
                bucket = []
            thread_index[thread_key] = _append_unique(bucket, artifact_id)
    task_index[task_id] = task_artifact_ids
    payload["schema_version"] = ARTIFACT_INDEX_SCHEMA_VERSION
    payload["updated_at"] = _text(task.get("updated_at")) or now_iso()
    payload["artifacts"] = artifacts
    payload["task_index"] = task_index
    payload["thread_index"] = thread_index
    _save_json(path, payload)
    return {"task_id": task_id, "artifact_count": len(task_artifact_ids)}


def list_artifacts(*, task_id: str = "", thread_key: str = "", path: str = ARTIFACT_INDEX_FILE) -> list[dict[str, Any]]:
    payload = load_artifact_index(path)
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts", {}), dict) else {}
    ids: list[str] = []
    if task_id:
        items = payload.get("task_index", {}).get(task_id, [])
        if isinstance(items, list):
            ids.extend(str(item).strip() for item in items if str(item).strip())
    if thread_key:
        items = payload.get("thread_index", {}).get(thread_key, [])
        if isinstance(items, list):
            ids.extend(str(item).strip() for item in items if str(item).strip())
    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    for artifact_id in ids:
        if artifact_id in seen:
            continue
        seen.add(artifact_id)
        entry = artifacts.get(artifact_id)
        if isinstance(entry, dict):
            results.append(entry)
    return results


def resolve_task_artifacts(
    task: dict[str, Any] | str,
    *,
    include_thread: bool = True,
    path: str = ARTIFACT_INDEX_FILE,
) -> list[dict[str, Any]]:
    if isinstance(task, dict):
        task_id = _text(task.get("id"))
        thread_key = _text(task.get("session_thread_key")) if include_thread else ""
    else:
        task_id = _text(task)
        thread_key = ""
    if not task_id and not thread_key:
        return []
    entries = list_artifacts(task_id=task_id, thread_key=thread_key, path=path)
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        artifact_id = _text(entry.get("artifact_id"))
        dedupe_key = artifact_id or f"{_text(entry.get('kind'))}:{_text(entry.get('path'))}:{_text(entry.get('task_id'))}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        payload = dict(entry)
        payload["source"] = "thread_index" if task_id and _text(entry.get("task_id")) != task_id else "task_index"
        payload["related_to_thread"] = bool(task_id and _text(entry.get("task_id")) != task_id)
        resolved.append(payload)
    resolved.sort(key=lambda item: (_text(item.get("updated_at")), _text(item.get("artifact_id"))), reverse=True)
    resolved.sort(key=lambda item: 1 if bool(item.get("related_to_thread")) else 0)
    return resolved


def upsert_ownership(task: dict[str, Any], *, path: str = OWNERSHIP_STORE_FILE) -> dict[str, Any]:
    payload = load_ownership_store(path)
    tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks", {}), dict) else {}
    snapshot = ownership_snapshot(task)
    tasks[_text(task.get("id"))] = snapshot
    payload["schema_version"] = OWNERSHIP_STORE_SCHEMA_VERSION
    payload["updated_at"] = _text(task.get("updated_at")) or now_iso()
    payload["tasks"] = tasks
    _save_json(path, payload)
    return snapshot


def upsert_worker_session(task: dict[str, Any], *, path: str = WORKER_SESSION_STORE_FILE) -> dict[str, Any]:
    payload = load_worker_session_store(path)
    sessions = payload.get("sessions", {}) if isinstance(payload.get("sessions", {}), dict) else {}
    task_index = payload.get("task_index", {}) if isinstance(payload.get("task_index", {}), dict) else {}
    snapshot = session_resume_snapshot(task)
    resume_key = _text(snapshot.get("resume_key"))
    task_id = _text(task.get("id"))
    if resume_key:
        sessions[resume_key] = snapshot
        bucket = task_index.get(task_id, [])
        if not isinstance(bucket, list):
            bucket = []
        task_index[task_id] = _append_unique(bucket, resume_key)
    payload["schema_version"] = WORKER_SESSION_STORE_SCHEMA_VERSION
    payload["updated_at"] = _text(task.get("updated_at")) or now_iso()
    payload["sessions"] = sessions
    payload["task_index"] = task_index
    _save_json(path, payload)
    return snapshot


def upsert_checklist(task: dict[str, Any], *, path: str = TASK_CHECKLIST_STORE_FILE) -> dict[str, Any]:
    payload = load_task_checklists(path)
    tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks", {}), dict) else {}
    snapshot = resolve_task_checklist(task, path=path)
    tasks[_text(task.get("id"))] = snapshot
    payload["schema_version"] = TASK_CHECKLIST_STORE_SCHEMA_VERSION
    payload["updated_at"] = _text(task.get("updated_at")) or now_iso()
    payload["tasks"] = tasks
    _save_json(path, payload)
    return snapshot


def sync_runtime_surfaces(task: dict[str, Any], *, thread_action: str = "") -> dict[str, Any]:
    session_key = _text(task.get("session_key"))
    if session_key:
        register_session_binding(
            session_key,
            {
                "origin": _text(task.get("session_origin")),
                "target": _text(task.get("session_target")),
                "thread_id": _text(task.get("session_thread_id")),
            },
            task=task,
            source="runtime_sync",
            action=thread_action or ("close" if _text(task.get("lifecycle_state")).lower() in FINAL_LIFECYCLE_STATES else "touch"),
        )
    artifact_summary = upsert_artifact_index(task)
    ownership = upsert_ownership(task)
    session_resume = upsert_worker_session(task)
    if _text(task.get("id")) and isinstance(task.get("resume_context"), dict) and task.get("resume_context"):
        try:
            from session_resume import save_resume_context
        except ModuleNotFoundError:  # pragma: no cover - package import path for tests
            from lib.session_resume import save_resume_context

        save_resume_context(_text(task.get("id")), dict(task.get("resume_context")), workspace=_workspace_for_store(WORKER_SESSION_STORE_FILE))
    previous_checklist = resolve_task_checklist(_text(task.get("id"))) if _text(task.get("id")) else {}
    checklist = upsert_checklist(task)
    _append_checklist_history_if_changed(task, previous_checklist, checklist)
    return {
        "artifact_count": int(artifact_summary.get("artifact_count", 0) or 0),
        "ownership_state": _text(ownership.get("state")),
        "resume_state": _text(session_resume.get("resume_state")),
        "checklist_open_count": int(checklist.get("open_count", 0) or 0),
    }


def recover_stale_ownership(tasks: list[dict[str, Any]], *, stale_after_seconds: int = 900) -> list[dict[str, Any]]:
    recovered: list[dict[str, Any]] = []
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=max(60, int(stale_after_seconds)))
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if _text(task.get("route")).lower() == "runner" or _text(task.get("runtime")).lower() == "runner":
            continue
        ownership = ownership_snapshot(task, lease_seconds=max(60, int(stale_after_seconds)))
        session_status = _text(task.get("session_status")).lower()
        should_recover = ownership.get("state") == "stale" and session_status in {"missing", "timeout", "stale", "lost"}
        if not should_recover:
            if ownership.get("state") != "claimed":
                continue
            heartbeat = _parse_iso(_text(ownership.get("last_heartbeat_at")))
            if heartbeat is None or heartbeat >= cutoff:
                continue
            should_recover = True
        if not should_recover:
            continue
        task["ownership"] = {**ownership, "state": "recovered", "lease_expires_at": ""}
        task["session_status"] = session_status or "lost"
        task["recovery_action"] = "dead_agent_recovered"
        task["last_recovered_at"] = now_iso()
        if _text(task.get("status")).lower() in {"running", "in_progress", "dispatched"}:
            task["status"] = "queued"
        recovered.append(task)
    return recovered


# ---------------------------------------------------------------------------
# Atomic ownership lock — compare-and-swap via POSIX advisory file lock
# ---------------------------------------------------------------------------

@contextmanager
def _exclusive_lock(path: str):
    """Acquire an exclusive advisory lock on `path + '.lock'`.

    Uses fcntl.LOCK_EX so only one process can hold the lock at a time.
    The lock is always released when the context manager exits, even on error.
    """
    lock_path = path + ".lock"
    _ensure_parent(lock_path)
    with open(lock_path, "w", encoding="utf-8") as lf:
        try:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def try_claim_ownership(
    task_id: str,
    owner_id: str,
    *,
    namespace: str = "octoclaw",
    lease_seconds: int = 900,
    path: str = OWNERSHIP_STORE_FILE,
) -> dict[str, Any]:
    """Atomically claim ownership of a task (compare-and-swap).

    Serialises concurrent callers with an OS-level advisory lock so only one
    process can write the "claimed" record at a time.

    Claimable conditions:
    - state is 'unclaimed' or 'recovered'
    - state is 'stale'  (session confirmed dead)
    - state is 'claimed' by the same owner_id  (idempotent re-claim / renewal)
    - state is 'claimed' but lease_expires_at is in the past  (lease expired)

    Returns a result dict:
      success  : bool
      reason   : 'claimed' | 'renewed' | 'already_claimed' | 'task_released' |
                 'missing_task_or_owner'
      state    : resulting ownership state string
      owner_id : current owner (may differ from caller on failure)
      version  : new version counter value
    """
    task_id = _text(task_id)
    owner_id = _text(owner_id)
    if not task_id or not owner_id:
        return {"success": False, "reason": "missing_task_or_owner", "state": "", "owner_id": "", "version": 0}

    now = datetime.now(timezone.utc)
    with _exclusive_lock(path):
        payload = load_ownership_store(path)
        tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks"), dict) else {}
        existing: dict[str, Any] = tasks.get(task_id, {}) if isinstance(tasks.get(task_id), dict) else {}

        existing_state = _text(existing.get("state")) or "unclaimed"
        existing_owner = _text(existing.get("owner_id"))
        version = int(existing.get("version") or 0)

        if existing_state == "released":
            return {"success": False, "reason": "task_released", "state": "released",
                    "owner_id": existing_owner, "version": version}

        if existing_state == "claimed" and existing_owner != owner_id:
            # Check whether the lease has expired; if so, the lock is claimable
            lease_expires_at = _parse_iso(_text(existing.get("lease_expires_at")))
            if lease_expires_at is not None and lease_expires_at > now:
                return {"success": False, "reason": "already_claimed", "state": "claimed",
                        "owner_id": existing_owner, "version": version}
            # Lease expired — fall through and overwrite

        claimed_at = now.isoformat()
        new_version = version + 1
        record: dict[str, Any] = {
            "task_id": task_id,
            "owner_id": owner_id,
            "owner_namespace": _text(namespace) or "octoclaw",
            "state": "claimed",
            "claimed_at": claimed_at,
            "last_heartbeat_at": claimed_at,
            "lease_seconds": max(60, int(lease_seconds)),
            "lease_expires_at": (now + timedelta(seconds=max(60, int(lease_seconds)))).isoformat(),
            "version": new_version,
        }
        tasks[task_id] = record
        payload["tasks"] = tasks
        payload["updated_at"] = claimed_at
        _save_json(path, payload)

    reason = "renewed" if existing_state == "claimed" and existing_owner == owner_id else "claimed"
    return {"success": True, "reason": reason, "state": "claimed", "owner_id": owner_id, "version": new_version}


def try_renew_ownership(
    task_id: str,
    owner_id: str,
    *,
    lease_seconds: int = 900,
    path: str = OWNERSHIP_STORE_FILE,
) -> dict[str, Any]:
    """Refresh the lease for a task currently owned by owner_id.

    Returns success=False if the caller is no longer the owner (e.g. the task
    was recovered by another agent).  Callers should treat a failed renewal as
    a signal to stop work and hand off cleanly.
    """
    task_id = _text(task_id)
    owner_id = _text(owner_id)
    if not task_id or not owner_id:
        return {"success": False, "reason": "missing_task_or_owner", "state": "", "owner_id": "", "version": 0}

    now = datetime.now(timezone.utc)
    with _exclusive_lock(path):
        payload = load_ownership_store(path)
        tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks"), dict) else {}
        existing: dict[str, Any] = tasks.get(task_id, {}) if isinstance(tasks.get(task_id), dict) else {}

        existing_state = _text(existing.get("state")) or "unclaimed"
        existing_owner = _text(existing.get("owner_id"))
        version = int(existing.get("version") or 0)

        if existing_state != "claimed" or existing_owner != owner_id:
            return {"success": False, "reason": "not_owner", "state": existing_state,
                    "owner_id": existing_owner, "version": version}

        new_heartbeat = now.isoformat()
        new_version = version + 1
        existing = dict(existing)
        existing["last_heartbeat_at"] = new_heartbeat
        existing["lease_expires_at"] = (now + timedelta(seconds=max(60, int(lease_seconds)))).isoformat()
        existing["version"] = new_version
        tasks[task_id] = existing
        payload["tasks"] = tasks
        payload["updated_at"] = new_heartbeat
        _save_json(path, payload)

    return {"success": True, "reason": "renewed", "state": "claimed", "owner_id": owner_id, "version": new_version}


def try_release_ownership(
    task_id: str,
    owner_id: str,
    *,
    path: str = OWNERSHIP_STORE_FILE,
) -> dict[str, Any]:
    """Release ownership of a task.

    Succeeds if the caller is the current owner OR if the lease has already
    expired (another agent may reclaim safely after this returns).
    Idempotent: releasing an already-released or unclaimed task returns
    success=True with reason='already_released'.
    """
    task_id = _text(task_id)
    owner_id = _text(owner_id)
    if not task_id or not owner_id:
        return {"success": False, "reason": "missing_task_or_owner", "state": "", "owner_id": "", "version": 0}

    now = datetime.now(timezone.utc)
    with _exclusive_lock(path):
        payload = load_ownership_store(path)
        tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks"), dict) else {}
        existing: dict[str, Any] = tasks.get(task_id, {}) if isinstance(tasks.get(task_id), dict) else {}

        existing_state = _text(existing.get("state")) or "unclaimed"
        existing_owner = _text(existing.get("owner_id"))
        version = int(existing.get("version") or 0)

        if existing_state in ("unclaimed", "released"):
            return {"success": True, "reason": "already_released", "state": existing_state,
                    "owner_id": existing_owner, "version": version}

        if existing_owner != owner_id:
            # Allow release only if the lease has expired (task is effectively abandoned)
            lease_expires_at = _parse_iso(_text(existing.get("lease_expires_at")))
            if lease_expires_at is not None and lease_expires_at > now:
                return {"success": False, "reason": "not_owner", "state": existing_state,
                        "owner_id": existing_owner, "version": version}

        new_version = version + 1
        record = dict(existing)
        record["state"] = "released"
        record["lease_expires_at"] = ""
        record["released_at"] = now.isoformat()
        record["version"] = new_version
        tasks[task_id] = record
        payload["tasks"] = tasks
        payload["updated_at"] = now.isoformat()
        _save_json(path, payload)

    return {"success": True, "reason": "released", "state": "released", "owner_id": owner_id, "version": new_version}


# ---------------------------------------------------------------------------
# Dead-agent recovery
# ---------------------------------------------------------------------------

def build_recovery_event(task_id: str, old_owner_id: str, reason: str) -> dict[str, Any]:
    task_text = _text(task_id)
    owner_text = _text(old_owner_id)
    reason_text = _text(reason) or "unspecified"
    return {
        "event_key": _artifact_id(task_text or "task", "recovery", f"{owner_text or 'unowned'}:{reason_text}"),
        "event_type": "reassignment",
        "task_id": task_text,
        "old_owner_id": owner_text,
        "reason": reason_text,
        "target_lifecycle_state": "queued",
    }


def mark_task_for_reassignment(task_record: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task_record, dict):
        return {}
    history = task_record.get("recovery_history", [])
    recovery_history = [dict(entry) for entry in history if isinstance(entry, dict)]
    old_owner_id = _text(task_record.get("owner")) or _text(task_record.get("agent_id"))
    if not old_owner_id:
        for entry in reversed(recovery_history):
            old_owner_id = _text(entry.get("old_owner_id"))
            if old_owner_id:
                break
    reason = _text(task_record.get("recovery_reason")) or "stale_agent"
    event = build_recovery_event(_text(task_record.get("id")), old_owner_id, reason)
    if not any(_text(entry.get("event_key")) == _text(event.get("event_key")) for entry in recovery_history):
        recovery_history.append(event)

    task_record["status"] = "queued"
    task_record["lifecycle_state"] = "queued"
    task_record["outcome_state"] = "pending"
    task_record["handoff_state"] = "none"
    task_record["owner"] = ""
    task_record["agent_id"] = ""
    task_record["session_id"] = ""
    task_record["run_id"] = ""
    task_record["session_status"] = ""
    task_record["last_observed_at"] = ""
    task_record["recovery_action"] = "queued_for_reassignment"
    task_record["recovery_reason"] = reason
    task_record["recovery_history"] = recovery_history
    if not _text(task_record.get("last_recovered_at")):
        task_record["last_recovered_at"] = now_iso()
    task_record["ownership"] = ownership_snapshot(task_record)
    task_record["session_resume"] = session_resume_snapshot(task_record)
    try:
        from session_resume import clear_resume_context
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.session_resume import clear_resume_context

    clear_resume_context(_text(task_record.get("id")), workspace=_workspace_for_store(WORKER_SESSION_STORE_FILE))
    return task_record
