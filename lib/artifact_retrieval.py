#!/usr/bin/env python3
"""Artifact retrieval helpers for OctoClaw context assembly."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ARTIFACT_INDEX_SCHEMA_VERSION = "octoclaw.artifact_index/v1"


def _artifact_index_path(workspace: str | Path) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "artifact-index.json"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _parse_iso(value: str) -> datetime:
    text = _text(value)
    if not text:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        raw = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _compact_text(text: str, limit: int = 96) -> str:
    collapsed = " ".join(_text(text).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _normalize_tags(entry: dict[str, Any]) -> set[str]:
    raw = entry.get("tags", entry.get("tag", entry.get("labels", [])))
    if isinstance(raw, list):
        return {_text(item).lower() for item in raw if _text(item)}
    if isinstance(raw, str):
        return {_text(part).lower() for part in raw.split(",") if _text(part)}
    return set()


def _normalize_artifact_type(entry: dict[str, Any]) -> str:
    return _text(entry.get("kind") or entry.get("artifact_type") or entry.get("type")).lower()


def _normalize_index_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    if isinstance(payload.get("artifacts"), dict) or isinstance(payload.get("task_index"), dict):
        normalized = dict(payload)
        normalized.setdefault("schema_version", ARTIFACT_INDEX_SCHEMA_VERSION)
        normalized.setdefault("updated_at", "")
        normalized.setdefault("artifacts", {})
        normalized.setdefault("task_index", {})
        normalized.setdefault("thread_index", {})
        if not isinstance(normalized.get("artifacts"), dict):
            normalized["artifacts"] = {}
        if not isinstance(normalized.get("task_index"), dict):
            normalized["task_index"] = {}
        if not isinstance(normalized.get("thread_index"), dict):
            normalized["thread_index"] = {}
        return normalized

    artifacts: dict[str, dict[str, Any]] = {}
    task_index: dict[str, list[str]] = {}
    for task_id, bucket in payload.items():
        if not isinstance(bucket, dict):
            continue
        entries = bucket.get("artifacts", []) if isinstance(bucket.get("artifacts", []), list) else []
        ids: list[str] = []
        for idx, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            artifact_id = _text(entry.get("artifact_id")) or f"{_text(task_id)}:artifact:{idx+1}"
            normalized_entry = dict(entry)
            normalized_entry.setdefault("artifact_id", artifact_id)
            normalized_entry.setdefault("task_id", _text(task_id))
            normalized_entry.setdefault("updated_at", _text(bucket.get("updated_at")) or _now_iso())
            artifacts[artifact_id] = normalized_entry
            ids.append(artifact_id)
        if ids:
            task_index[_text(task_id)] = ids
    return {
        "schema_version": ARTIFACT_INDEX_SCHEMA_VERSION,
        "updated_at": _now_iso(),
        "artifacts": artifacts,
        "task_index": task_index,
        "thread_index": {},
    }


def _load_artifact_index(workspace: str | Path) -> dict[str, Any]:
    path = _artifact_index_path(workspace)
    if not path.exists():
        return {
            "schema_version": ARTIFACT_INDEX_SCHEMA_VERSION,
            "updated_at": "",
            "artifacts": {},
            "task_index": {},
            "thread_index": {},
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    return _normalize_index_payload(payload)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _iter_candidates(payload: dict[str, Any], task_ids: list[str] | None = None) -> list[dict[str, Any]]:
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts", {}), dict) else {}
    task_index = payload.get("task_index", {}) if isinstance(payload.get("task_index", {}), dict) else {}
    if not task_ids:
        return [dict(entry) for entry in artifacts.values() if isinstance(entry, dict)]

    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for task_id in task_ids:
        for artifact_id in task_index.get(task_id, []):
            artifact_key = _text(artifact_id)
            if not artifact_key or artifact_key in seen:
                continue
            entry = artifacts.get(artifact_key)
            if isinstance(entry, dict):
                seen.add(artifact_key)
                resolved.append(dict(entry))
    return resolved


def search_artifacts(
    *,
    workspace: str | Path,
    task_ids: list[str] | None = None,
    tags: list[str] | None = None,
    artifact_types: list[str] | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    if int(limit or 0) <= 0:
        return []
    normalized_task_ids = [_text(task_id) for task_id in (task_ids or []) if _text(task_id)]
    wanted_tags = {_text(tag).lower() for tag in (tags or []) if _text(tag)}
    wanted_types = {_text(kind).lower() for kind in (artifact_types or []) if _text(kind)}

    payload = _load_artifact_index(workspace)
    entries = _iter_candidates(payload, normalized_task_ids or None)
    results: list[dict[str, Any]] = []
    for entry in entries:
        entry_tags = _normalize_tags(entry)
        entry_type = _normalize_artifact_type(entry)
        if wanted_tags and not (entry_tags & wanted_tags):
            continue
        if wanted_types and entry_type not in wanted_types:
            continue
        results.append(entry)

    results.sort(key=lambda item: (_parse_iso(_text(item.get("updated_at"))), _text(item.get("artifact_id"))), reverse=True)
    return results[: max(0, int(limit))]


def get_artifact_content(artifact_id: str, *, workspace: str | Path) -> str | None:
    artifact_key = _text(artifact_id)
    if not artifact_key:
        return None
    payload = _load_artifact_index(workspace)
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts", {}), dict) else {}
    entry = artifacts.get(artifact_key, {})
    if not isinstance(entry, dict) or not entry:
        return None
    path_text = _text(entry.get("path"))
    if path_text:
        artifact_path = Path(path_text)
        if artifact_path.exists() and artifact_path.is_file():
            return artifact_path.read_text(encoding="utf-8", errors="replace")[:8000]
    if entry.get("content") is None:
        return None
    return str(entry.get("content"))[:8000]


def build_artifact_context_section(task_ids: list[str], *, workspace: str | Path, limit: int = 5) -> str:
    normalized_task_ids = [_text(task_id) for task_id in (task_ids or []) if _text(task_id)]
    if not normalized_task_ids:
        return ""
    entries = search_artifacts(workspace=workspace, task_ids=normalized_task_ids, limit=limit)
    if not entries:
        return ""

    lines = ["## Relevant artifacts"]
    for entry in entries:
        artifact_id = _text(entry.get("artifact_id"))
        content = get_artifact_content(artifact_id, workspace=workspace) or _text(entry.get("preview")) or _text(entry.get("content"))
        char_count = len(content)
        kind = _normalize_artifact_type(entry) or "artifact"
        title = _compact_text(_text(entry.get("title")) or Path(_text(entry.get("path"))).name or artifact_id, 88)
        task_id = _text(entry.get("task_id")) or "unknown-task"
        lines.append(f"- [{kind}] {task_id}: {title} ({char_count} chars)")
    return "\n".join(lines)


def prune_artifact_index(*, workspace: str | Path, keep_per_task: int = 10) -> dict[str, Any]:
    keep_limit = max(0, int(keep_per_task))
    payload = _load_artifact_index(workspace)
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts", {}), dict) else {}
    task_index = payload.get("task_index", {}) if isinstance(payload.get("task_index", {}), dict) else {}
    thread_index = payload.get("thread_index", {}) if isinstance(payload.get("thread_index", {}), dict) else {}

    new_task_index: dict[str, list[str]] = {}
    kept_ids: set[str] = set()
    removed = 0

    for task_id, artifact_ids in task_index.items():
        ids = [_text(item) for item in artifact_ids if _text(item)]
        entries = [artifacts.get(artifact_id) for artifact_id in ids if isinstance(artifacts.get(artifact_id), dict)]
        entries.sort(key=lambda item: (_parse_iso(_text(item.get("updated_at"))), _text(item.get("artifact_id"))), reverse=True)
        kept = [_text(entry.get("artifact_id")) for entry in entries[:keep_limit] if isinstance(entry, dict) and _text(entry.get("artifact_id"))]
        kept_ids.update(kept)
        if kept:
            new_task_index[_text(task_id)] = kept
        removed += max(0, len(ids) - len(kept))

    new_artifacts = {
        artifact_id: dict(entry)
        for artifact_id, entry in artifacts.items()
        if artifact_id in kept_ids and isinstance(entry, dict)
    }
    new_thread_index: dict[str, list[str]] = {}
    for thread_key, artifact_ids in thread_index.items():
        if not isinstance(artifact_ids, list):
            continue
        filtered = [_text(item) for item in artifact_ids if _text(item) in kept_ids]
        if filtered:
            new_thread_index[_text(thread_key)] = filtered

    payload["schema_version"] = ARTIFACT_INDEX_SCHEMA_VERSION
    payload["updated_at"] = _now_iso()
    payload["artifacts"] = new_artifacts
    payload["task_index"] = new_task_index
    payload["thread_index"] = new_thread_index
    _atomic_write_json(_artifact_index_path(workspace), payload)
    return {
        "kept_per_task": keep_limit,
        "removed_artifact_count": removed,
        "remaining_artifact_count": len(new_artifacts),
        "task_count": len(new_task_index),
    }
