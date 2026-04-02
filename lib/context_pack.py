#!/usr/bin/env python3
"""Structured context pack helpers for long-running follow-ups."""

from __future__ import annotations

import json
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

try:
    from runtime_coordination import resolve_task_artifacts
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_coordination import resolve_task_artifacts

try:
    from runtime_task_record import normalize_task_record
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import normalize_task_record

try:
    from artifact_retrieval import build_artifact_context_section
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.artifact_retrieval import build_artifact_context_section


CONTEXT_PACK_SCHEMA_VERSION = "octoclaw.context_pack/v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def compact_text(text: str, limit: int = 160) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _short_pool(worker_pool: str) -> str:
    return _text(worker_pool).replace("octoclaw-", "")


def _artifact_preview(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "artifact_id": _text(entry.get("artifact_id")),
        "kind": _text(entry.get("kind")),
        "title": compact_text(_text(entry.get("title")), 96),
        "path": _text(entry.get("path")),
        "preview": compact_text(_text(entry.get("preview")), 120),
        "related_to_thread": bool(entry.get("related_to_thread")),
    }


def _event_preview(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": _text(entry.get("time")),
        "kind": _text(entry.get("kind")),
        "message": compact_text(_text(entry.get("message")), 120),
        "importance": _text(entry.get("importance")) or "normal",
    }


def related_task_context(task: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_task_record(task)
    artifacts = resolve_task_artifacts(normalized, include_thread=False)[:2]
    checklist = normalized.get("checklist") if isinstance(normalized.get("checklist"), dict) else {}
    task_events = normalized.get("task_events_preview", []) if isinstance(normalized.get("task_events_preview"), list) else []
    worker_result = ((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("worker_result")
    next_step = _text(worker_result.get("next_step")) if isinstance(worker_result, dict) else ""
    return {
        "task_id": _text(normalized.get("id")),
        "title": compact_text(_text(normalized.get("title") or normalized.get("task_description")), 96),
        "summary": compact_text(_text(normalized.get("summary") or normalized.get("task_description")), 160),
        "route": _text(normalized.get("route")),
        "worker_pool": _text(normalized.get("worker_pool")),
        "status": _text(normalized.get("status")),
        "lifecycle_state": _text(normalized.get("lifecycle_state")),
        "outcome_state": _text(normalized.get("outcome_state")),
        "handoff_state": _text(normalized.get("handoff_state")),
        "report_path": _text(normalized.get("report_path")),
        "context_path": _text(normalized.get("context_path")),
        "artifacts": [_artifact_preview(item) for item in artifacts if isinstance(item, dict)],
        "checklist": {
            "kind": _text(checklist.get("kind")),
            "open_count": int(checklist.get("open_count", 0) or 0),
            "completed_count": int(checklist.get("completed_count", 0) or 0),
        },
        "task_events": [_event_preview(item) for item in task_events[:3] if isinstance(item, dict)],
        "next_step": compact_text(next_step, 120),
        "updated_at": _text(normalized.get("updated_at")),
    }


def _render_entry(entry: dict[str, Any]) -> list[str]:
    task_id = _text(entry.get("task_id"))
    summary = _text(entry.get("summary"))
    route = _text(entry.get("route"))
    pool = _short_pool(_text(entry.get("worker_pool")))
    outcome = _text(entry.get("outcome_state")) or _text(entry.get("status"))
    checklist = entry.get("checklist") if isinstance(entry.get("checklist"), dict) else {}
    open_count = int(checklist.get("open_count", 0) or 0)
    completed_count = int(checklist.get("completed_count", 0) or 0)
    parts = [f"- {task_id}", f"{pool or '?'}", f"{route or '?'}", f"{outcome or '?'}"]
    header = " · ".join(part for part in parts if part)
    lines = [header]
    if summary:
        lines.append(f"  summary: {summary}")
    if completed_count or open_count:
        lines.append(f"  checklist: {completed_count} done / {open_count} open")
    next_step = _text(entry.get("next_step"))
    if next_step and next_step.lower() != "none":
        lines.append(f"  next: {next_step}")
    artifacts = entry.get("artifacts", []) if isinstance(entry.get("artifacts"), list) else []
    if artifacts:
        titles = ", ".join(_text(item.get("title")) or _text(item.get("kind")) for item in artifacts[:2] if isinstance(item, dict))
        if titles:
            lines.append(f"  artifacts: {compact_text(titles, 120)}")
    events = entry.get("task_events", []) if isinstance(entry.get("task_events"), list) else []
    if events:
        latest = events[0]
        lines.append(f"  latest: {_text(latest.get('kind'))} · {_text(latest.get('message'))}")
    return lines


def _resolve_workspace(context_dir: str) -> str:
    candidates: list[Path] = []
    env_workspace = _text(os.environ.get("WORKSPACE"))
    if env_workspace:
        candidates.append(Path(env_workspace).resolve())
    context_path = Path(context_dir).resolve()
    candidates.extend([context_path.parent, context_path])
    if len(context_path.parents) >= 3:
        candidates.append(context_path.parents[2])

    seen: set[str] = set()
    for candidate in candidates:
        candidate_text = str(candidate)
        if candidate_text in seen:
            continue
        seen.add(candidate_text)
        if (candidate / "tmp" / "octopus" / "artifact-index.json").exists():
            return candidate_text
    return env_workspace or str(context_path.parent)


def build_context_pack(
    *,
    task_id: str,
    requested_task: str,
    related_tasks: list[dict[str, Any]],
    context_dir: str,
) -> dict[str, Any]:
    entries = [related_task_context(task) for task in related_tasks if isinstance(task, dict)]
    summary_lines: list[str] = []
    for entry in entries[:3]:
        summary_lines.extend(_render_entry(entry))
    summary = "\n".join(summary_lines).strip()
    task_ids = [_text(entry.get("task_id")) for entry in entries[:3] if _text(entry.get("task_id"))]
    artifact_section = build_artifact_context_section(task_ids, workspace=_resolve_workspace(context_dir), limit=5)
    sections: list[dict[str, str]] = []
    if summary:
        sections.append({"title": "Compact Summary", "content": summary})
    if artifact_section:
        sections.append({"title": "Relevant artifacts", "content": artifact_section})
    pack = {
        "schema_version": CONTEXT_PACK_SCHEMA_VERSION,
        "task_id": _text(task_id),
        "requested_task": compact_text(requested_task, 400),
        "generated_at": now_iso(),
        "related_task_count": len(entries),
        "summary": summary,
        "sections": sections,
        "related_tasks": entries[:3],
        "compact_rules": {
            "max_related_tasks": 3,
            "max_artifacts_per_task": 2,
            "max_events_per_task": 3,
            "artifact_first": True,
        },
    }

    context_summary = compact_text(summary.replace("\n", " "), 480)
    context_path = ""
    context_pack_path = ""
    if summary or entries:
        os.makedirs(context_dir, exist_ok=True)
        context_pack_path = os.path.join(context_dir, f"{task_id}.context.json")
        context_path = os.path.join(context_dir, f"{task_id}.md")
        with open(context_pack_path, "w", encoding="utf-8") as handle:
            json.dump(pack, handle, ensure_ascii=False, indent=2)
        markdown = "\n".join(
            [
                f"# OctoClaw Context Pack: {_text(task_id)}",
                "",
                "## Requested Task",
                requested_task.strip(),
                "",
                "## Compact Summary",
                summary or "(no related context found)",
                "",
                artifact_section,
                "" if artifact_section else "",
                "## Rules",
                "- Prefer this compact pack before reopening raw transcripts.",
                "- Follow artifact paths or context paths only when the compact pack is insufficient.",
                "- Keep future follow-ups artifact-first and checklist-aware.",
            ]
        ).rstrip() + "\n"
        with open(context_path, "w", encoding="utf-8") as handle:
            handle.write(markdown)

    refs = [
        {
            "task_id": _text(entry.get("task_id")),
            "status": _text(entry.get("status")),
            "summary": _text(entry.get("summary")),
            "report_path": _text(entry.get("report_path")),
            "route": _text(entry.get("route")),
            "worker_pool": _text(entry.get("worker_pool")),
            "work_type": "",
            "phase": "",
            "next_step": _text(entry.get("next_step")),
        }
        for entry in entries[:3]
    ]
    return {
        "summary": context_summary,
        "refs": refs,
        "context_path": context_path,
        "context_pack_path": context_pack_path,
        "context_pack": pack,
        "budget": {
            "inline_history_max_items": 3,
            "inline_history_max_chars": 480,
            "share_large_context": True,
            "prefer_context_pack": True,
        },
    }
