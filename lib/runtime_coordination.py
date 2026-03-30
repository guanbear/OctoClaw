#!/usr/bin/env python3
"""Shared runtime coordination surfaces for OctoClaw."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from task_events import register_session_binding
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_events import register_session_binding


WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
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
    task_id = _text(task.get("id"))
    agent_id = _text(task.get("agent_id")) or _text(task.get("owner"))
    agent_namespace = _text(task.get("agent_namespace")) or ("octoclaw" if agent_id else "")
    session_id = _text(task.get("session_id"))
    run_id = _text(task.get("run_id"))
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
    elif task_id:
        resume_key = f"task:{task_id}"

    return {
        "task_id": task_id,
        "resume_key": resume_key,
        "agent_id": agent_id,
        "agent_namespace": agent_namespace,
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
    if isinstance(explicit, dict):
        items = explicit.get("items", []) if isinstance(explicit.get("items", []), list) else []
        kind = _text(explicit.get("kind")) or "explicit"
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


def load_task_checklists(path: str = TASK_CHECKLIST_STORE_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    payload.setdefault("schema_version", TASK_CHECKLIST_STORE_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("tasks", {})
    return payload


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
    snapshot = checklist_snapshot(task)
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
    checklist = upsert_checklist(task)
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
