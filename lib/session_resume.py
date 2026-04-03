#!/usr/bin/env python3
"""Session resume context persistence helpers for OctoClaw."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


MAX_RESULT_SNIPPET_CHARS = 240


def _store_path(workspace: str | Path) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "session-resume-contexts.json"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _compact_text(value: Any, limit: int = MAX_RESULT_SNIPPET_CHARS) -> str:
    text = " ".join(_text(value).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _load_store(workspace: str | Path) -> dict[str, dict[str, Any]]:
    path = _store_path(workspace)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        _text(task_id): dict(record)
        for task_id, record in payload.items()
        if _text(task_id) and isinstance(record, dict)
    }


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _normalized_open_items(value: Any) -> list[str]:
    if isinstance(value, list):
        items: list[str] = []
        for item in value:
            if isinstance(item, dict):
                label = _text(item.get("title")) or _text(item.get("id"))
            else:
                label = _text(item)
            if label:
                items.append(label)
        return items
    if isinstance(value, str):
        return [_text(part) for part in value.split(",") if _text(part)]
    return []


def _normalize_context(context: Any) -> dict[str, Any]:
    if not isinstance(context, dict):
        return {}
    phase = _text(context.get("current_phase")) or _text(context.get("phase"))
    progress = _text(context.get("progress_summary")) or _text(context.get("progress")) or _text(context.get("summary"))
    open_items = _normalized_open_items(context.get("open_checklist_items"))
    if not open_items:
        open_items = _normalized_open_items(context.get("open_items"))
    last_result_value = context.get("last_tool_result")
    if last_result_value in (None, "", [], {}):
        last_result_value = context.get("last_result")
    if isinstance(last_result_value, dict):
        last_result = _compact_text(json.dumps(last_result_value, ensure_ascii=False, sort_keys=True))
    else:
        last_result = _compact_text(last_result_value)
    normalized = {
        "current_phase": phase,
        "progress_summary": progress,
        "open_checklist_items": open_items,
        "last_tool_result": last_result,
    }
    return {key: value for key, value in normalized.items() if value not in ("", [], None)}


def save_resume_context(task_id: str, context: dict[str, Any], *, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {}
    normalized = _normalize_context(context)
    if not normalized:
        return {}
    store = _load_store(workspace)
    store[task_key] = normalized
    _atomic_write_json(_store_path(workspace), store)
    return dict(normalized)


def load_resume_context(task_id: str, *, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {}
    return dict(_load_store(workspace).get(task_key, {}))


def build_resume_prompt_section(task_id: str, *, workspace: str | Path) -> str:
    context = load_resume_context(task_id, workspace=workspace)
    if not context:
        return ""
    phase = _text(context.get("current_phase")) or "unknown"
    progress = _text(context.get("progress_summary")) or "none"
    open_items = context.get("open_checklist_items")
    open_items_text = ", ".join(_normalized_open_items(open_items)) if open_items else "none"
    last_result = _text(context.get("last_tool_result")) or "none"
    return "\n".join(
        [
            "## Resumed task context",
            f"- Phase: {phase}",
            f"- Progress: {progress}",
            f"- Open items: {open_items_text}",
            f"- Last result: {last_result}",
        ]
    )


def clear_resume_context(task_id: str, *, workspace: str | Path) -> dict[str, Any]:
    task_key = _text(task_id)
    if not task_key:
        return {}
    store = _load_store(workspace)
    removed = store.pop(task_key, {})
    if removed:
        _atomic_write_json(_store_path(workspace), store)
    return dict(removed) if isinstance(removed, dict) else {}
