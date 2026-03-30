#!/usr/bin/env python3
"""Shared task display adapter and renderers for Phase 5A."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

try:
    from runtime_task_record import task_is_recent_final, task_queue_bucket, task_state_model
    from runtime_coordination import resolve_task_artifacts
    from worker_taxonomy import role_display
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import task_is_recent_final, task_queue_bucket, task_state_model
    from lib.runtime_coordination import resolve_task_artifacts
    from lib.worker_taxonomy import role_display


ACTIVE_STATES = {"queued", "running", "blocked"}
QUEUE_STATES = {"queued"}
RUNNING_STATES = {"running"}
BLOCKED_STATES = {"blocked"}
FINAL_STATES = {"done", "completed", "failed", "deferred", "cancelled", "blocked", "partial"}
GENERIC_SUMMARY_PREFIXES = (
    "runner完成",
    "runner失败",
    "runner completed",
    "runner failed",
    "spawn_single running:",
    "spawn_multi running:",
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _text_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def action_command_value(task_id: str, fallback_command: str) -> str:
    command = _text(fallback_command)
    task_ref = _text(task_id)
    return f"{command} {task_ref}".strip() if command else ""


def _normalize_task(task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {}
    if _text(task.get("schema_version")).startswith("octoclaw.runtime_task.record/"):
        return dict(task)
    try:
        from runtime_task_record import normalize_task_record
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.runtime_task_record import normalize_task_record
    normalized = normalize_task_record(task)
    if isinstance(task.get("task_events_preview"), list):
        normalized["task_events_preview"] = [event for event in task["task_events_preview"] if isinstance(event, dict)]
    if isinstance(task.get("task_event_summary"), dict):
        normalized["task_event_summary"] = dict(task["task_event_summary"])
    return normalized


def _compact(text: str, limit: int = 96) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _is_jsonish_fragment(text: str) -> bool:
    value = _text(text)
    return value.startswith("{") or value.startswith("[") or value.startswith("```")


def _summary_is_generic(text: str) -> bool:
    value = _text(text).lower()
    return any(value.startswith(prefix.lower()) for prefix in GENERIC_SUMMARY_PREFIXES)


def _clean_task_summary(task: dict[str, Any], *, limit: int = 120) -> str:
    summary = _text(task.get("user_safe_summary") or task.get("summary"))
    task_description = _text(task.get("task_description"))
    if not summary:
        return _compact(task_description, limit=limit)
    if _summary_is_generic(summary):
        tail = summary.split(":", 1)[1].strip() if ":" in summary else ""
        if tail and not _is_jsonish_fragment(tail):
            return _compact(tail, limit=limit)
        if task_description:
            return _compact(task_description, limit=limit)
    if _is_jsonish_fragment(summary) and task_description:
        return _compact(task_description, limit=limit)
    return _compact(summary, limit=limit)


def _task_title(task: dict[str, Any], *, limit: int = 96) -> str:
    explicit = _text(task.get("title"))
    if explicit:
        return _compact(explicit, limit=limit)
    task_description = _text(task.get("task_description"))
    summary = _text(task.get("user_safe_summary") or task.get("summary"))
    if task_description and (not summary or _summary_is_generic(summary) or _is_jsonish_fragment(summary)):
        return _compact(task_description, limit=limit)
    if summary:
        cleaned = _clean_task_summary(task, limit=limit)
        if cleaned:
            return cleaned
    return _compact(_text(task.get("id")), limit=limit)


def _parse_time(value: str) -> datetime | None:
    raw = _text(value)
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except Exception:
        return None


def _iso_now(now: datetime | None = None) -> datetime:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current


def _duration_label(started_at: str, now: datetime | None = None) -> str | None:
    started = _parse_time(started_at)
    if not started:
        return None
    current = _iso_now(now)
    seconds = max(0, int((current - started).total_seconds()))
    if seconds < 60:
        return f"{seconds}s"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m" if sec < 30 else f"{minutes + 1}m"
    hours, minute = divmod(minutes, 60)
    if minute == 0:
        return f"{hours}h"
    return f"{hours}h{minute}m"


def _state_label(state: str, lifecycle_state: str = "", outcome_state: str = "", handoff_state: str = "") -> str:
    current = _text(state).lower()
    lifecycle = _text(lifecycle_state).lower()
    outcome = _text(outcome_state).lower()
    handoff = _text(handoff_state).lower()
    if lifecycle in {"finished", "cancelled"} and outcome == "blocked":
        return "blocked (handoff ready)" if handoff in {"user_safe_ready", "delivered"} else "blocked"
    if lifecycle in {"finished", "cancelled"} and outcome == "partial":
        return "partial answer"
    mapping = {
        "queued": "queued",
        "running": "running",
        "blocked": "blocked",
        "needs_approval": "needs approval",
        "done": "completed",
        "completed": "completed",
        "failed": "failed",
        "deferred": "deferred",
        "cancelled": "cancelled",
    }
    return mapping.get(current, current or "unknown")


def _collect_active_models(task: dict[str, Any]) -> list[str]:
    models: list[str] = []
    primary = _text(task.get("model"))
    if primary:
        models.append(primary)

    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    step_models = artifacts.get("step_models", {}) if isinstance(artifacts.get("step_models", {}), dict) else {}
    for raw in step_models.values():
        if not isinstance(raw, dict):
            continue
        model = _text(raw.get("model"))
        if model and model not in models:
            models.append(model)

    worker_result = artifacts.get("worker_result") if isinstance(artifacts.get("worker_result"), dict) else {}
    result_model = _text(worker_result.get("model"))
    if result_model and result_model not in models:
        models.append(result_model)
    return models


def _collect_artifacts(task: dict[str, Any]) -> list[dict[str, Any]]:
    indexed_rows = resolve_task_artifacts(task, include_thread=True)
    if indexed_rows:
        rows: list[dict[str, Any]] = []
        for artifact in indexed_rows:
            if not isinstance(artifact, dict):
                continue
            title = _text(artifact.get("title")) or _text(artifact.get("artifact_id")) or "Artifact"
            if artifact.get("related_to_thread"):
                related_task_id = _text(artifact.get("task_id"))
                title = f"{title} · {related_task_id}" if related_task_id else f"{title} · thread"
            rows.append(
                {
                    "artifact_id": _text(artifact.get("artifact_id")),
                    "kind": _text(artifact.get("kind")),
                    "title": title,
                    "path": _text(artifact.get("path")),
                    "preview": _compact(_text(artifact.get("preview")), limit=72),
                    "ready": True,
                    "source": _text(artifact.get("source")) or "task_index",
                    "task_id": _text(artifact.get("task_id")),
                    "related_to_thread": bool(artifact.get("related_to_thread")),
                }
            )
        return rows

    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    rows: list[dict[str, Any]] = []
    report_path = _text(artifacts.get("report_path") or task.get("report_path"))
    if report_path:
        rows.append(
            {
                "artifact_id": "report",
                "kind": "report",
                "title": "Report",
                "path": report_path,
                "preview": "",
                "ready": True,
            }
        )
    context_path = _text(artifacts.get("context_path") or task.get("context_path"))
    if context_path:
        rows.append(
            {
                "artifact_id": "context",
                "kind": "summary",
                "title": "Context summary",
                "path": context_path,
                "preview": _compact(_text(artifacts.get("context_summary") or task.get("context_summary")), limit=72),
                "ready": True,
            }
        )
    files_changed = _text_list(artifacts.get("files_changed") or task.get("files_changed"))
    if files_changed:
        rows.append(
            {
                "artifact_id": "files",
                "kind": "patch",
                "title": f"Files changed ({len(files_changed)})",
                "path": "",
                "preview": ", ".join(files_changed[:3]) + ("…" if len(files_changed) > 3 else ""),
                "ready": True,
            }
        )
    return rows


def build_task_actions(task: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = _normalize_task(task)
    state_model = task_state_model(normalized)
    state = _text(normalized.get("status")).lower()
    queue_bucket = task_queue_bucket(normalized)
    is_terminal = _text(state_model.get("lifecycle_state")).lower() in {"finished", "cancelled"}
    actions: list[dict[str, Any]] = [
        {
            "id": "view",
            "kind": "view",
            "label": "View",
            "enabled": True,
            "danger": False,
            "requires_confirmation": False,
            "fallback_command": "details",
        },
        {
            "id": "show_queue",
            "kind": "show_queue",
            "label": "Queue",
            "enabled": True,
            "danger": False,
            "requires_confirmation": False,
            "fallback_command": "queue",
        },
    ]

    if queue_bucket in ACTIVE_STATES and not is_terminal:
        actions.append(
            {
                "id": "stop",
                "kind": "stop",
                "label": "Stop",
                "enabled": True,
                "danger": True,
                "requires_confirmation": True,
                "fallback_command": "stop",
            }
        )

    artifacts = _collect_artifacts(normalized)
    if artifacts:
        actions.append(
            {
                "id": "open_artifacts",
                "kind": "open_artifacts",
                "label": "Artifacts",
                "enabled": True,
                "danger": False,
                "requires_confirmation": False,
                "fallback_command": "artifacts",
            }
        )

    if state == "needs_approval":
        actions.extend(
            [
                {
                    "id": "approve",
                    "kind": "approve",
                    "label": "Approve",
                    "enabled": True,
                    "danger": False,
                    "requires_confirmation": False,
                    "fallback_command": "approve",
                },
                {
                    "id": "reject",
                    "kind": "reject",
                    "label": "Reject",
                    "enabled": True,
                    "danger": True,
                    "requires_confirmation": True,
                    "fallback_command": "reject",
                },
            ]
        )

    if state in {"failed", "deferred"} or (
        is_terminal and _text(state_model.get("outcome_state")).lower() in {"blocked", "partial"}
    ):
        actions.append(
            {
                "id": "retry",
                "kind": "retry",
                "label": "Retry",
                "enabled": True,
                "danger": False,
                "requires_confirmation": False,
                "fallback_command": "retry",
            }
        )

    return actions


def build_task_interactive_payload(
    task: dict[str, Any],
    *,
    anchor: dict[str, Any] | None = None,
    actions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized = _normalize_task(task)
    task_anchor = anchor if isinstance(anchor, dict) else build_task_anchor(normalized)
    task_actions = actions if isinstance(actions, list) else build_task_actions(normalized)
    task_id = _text(task_anchor.get("task_id"))
    title = _text(task_anchor.get("title")) or task_id or "OctoClaw task"
    summary = _text(task_anchor.get("summary"))

    blocks: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": f"OctoClaw task: {title}",
        }
    ]
    if summary:
        blocks.append({"type": "text", "text": summary})

    buttons: list[dict[str, Any]] = []
    for item in task_actions[:5]:
        if not isinstance(item, dict) or not bool(item.get("enabled", False)):
            continue
        label = _text(item.get("label")) or _text(item.get("kind")) or "Action"
        command = _text(item.get("fallback_command")) or _text(item.get("kind"))
        if not command:
            continue
        value = action_command_value(task_id, command)
        style = "danger" if bool(item.get("danger", False)) else "primary" if command in {"view", "details"} else "secondary"
        buttons.append(
            {
                "label": label[:75],
                "value": value[:200],
                "style": style,
            }
        )
    if buttons:
        blocks.append({"type": "buttons", "buttons": buttons})
    return {"blocks": blocks}


def build_task_anchor(task: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    normalized = _normalize_task(task)
    state_model = task_state_model(normalized)
    lifecycle_state = _text(state_model.get("lifecycle_state"))
    outcome_state = _text(state_model.get("outcome_state"))
    handoff_state = _text(state_model.get("handoff_state"))
    queue_bucket = task_queue_bucket(normalized)
    if _text(lifecycle_state).lower() in {"finished", "cancelled"}:
        if _text(outcome_state).lower() == "partial":
            state = "partial"
        elif _text(outcome_state).lower() in {"done", "blocked", "failed", "cancelled"}:
            state = _text(outcome_state).lower()
        else:
            state = _text(normalized.get("status")).lower()
    else:
        state = queue_bucket
    display = role_display(normalized)
    summary = _clean_task_summary(normalized, limit=120)
    models = _collect_active_models(normalized)

    anchor = {
        "task_id": _text(normalized.get("id")),
        "title": _task_title(normalized, limit=120),
        "state": state,
        "state_label": _state_label(state, lifecycle_state, outcome_state, handoff_state),
        "route": _text(normalized.get("route")),
        "worker_pool": _text(normalized.get("worker_pool")),
        "worker_pool_display": _text(display.get("name")),
        "worker_pool_emoji": _text(display.get("emoji")),
        "progress": None,
        "summary": summary,
        "queue_bucket": queue_bucket,
        "lifecycle_state": lifecycle_state,
        "outcome_state": outcome_state,
        "handoff_state": handoff_state,
        "terminal": _text(lifecycle_state).lower() in {"finished", "cancelled"},
        "deliverable_kind": _text(normalized.get("deliverable_kind")),
        "observability_health": _text(normalized.get("observability_health")),
        "session_status": _text(normalized.get("session_status")),
        "resume_state": _text(((normalized.get("session_resume") or {}) if isinstance(normalized.get("session_resume"), dict) else {}).get("resume_state")),
        "resume_key": _text(((normalized.get("session_resume") or {}) if isinstance(normalized.get("session_resume"), dict) else {}).get("resume_key")),
        "phase": _text(normalized.get("phase")),
        "profile": _text(normalized.get("profile")),
        "eta": _text(normalized.get("expected_done_at")),
        "queue_position": normalized.get("queue_position") if isinstance(normalized.get("queue_position"), int) else None,
        "cost_estimate": _text(normalized.get("cost_estimate")),
        "active_models": models,
        "model_summary": ", ".join(models[:2]) + ("…" if len(models) > 2 else "") if models else "",
        "started_at": _text(normalized.get("started_at")),
        "updated_at": _text(normalized.get("updated_at")),
        "duration": _duration_label(_text(normalized.get("started_at")), now=now),
    }
    return anchor


def build_task_detail(
    task: dict[str, Any],
    *,
    all_tasks: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    normalized = _normalize_task(task)
    anchor = build_task_anchor(normalized, now=now)
    state_model = task_state_model(normalized)
    all_normalized = [_normalize_task(item) for item in (all_tasks or []) if isinstance(item, dict)]
    task_id = _text(normalized.get("id"))
    child_ids = _text_list(normalized.get("child_ids"))
    if not child_ids:
        artifacts = normalized.get("artifacts", {}) if isinstance(normalized.get("artifacts", {}), dict) else {}
        child_ids = _text_list(artifacts.get("child_task_ids"))
        if not child_ids:
            step_task_ids = artifacts.get("step_task_ids", {}) if isinstance(artifacts.get("step_task_ids", {}), dict) else {}
            child_ids = [str(value).strip() for value in step_task_ids.values() if str(value).strip()]

    children = [item for item in all_normalized if _text(item.get("parent_id")) == task_id or _text(item.get("id")) in child_ids]
    artifacts = _collect_artifacts(normalized)
    preview_events = normalized.get("task_events_preview", []) if isinstance(normalized.get("task_events_preview", []), list) else []
    events: list[dict[str, Any]] = []
    if preview_events:
        events = [event for event in preview_events if isinstance(event, dict)]
    else:
        events.append(
            {
                "time": _text(normalized.get("updated_at") or normalized.get("completed_at") or normalized.get("started_at")),
                "kind": "route_selected",
                "message": f"{anchor['route']} via {anchor['worker_pool']}",
                "importance": "normal",
            }
        )
        if _text(state_model.get("handoff_state")).lower() in {"user_safe_ready", "delivered"}:
            events.append(
                {
                    "time": _text(normalized.get("handoff_ready_at") or normalized.get("completed_at") or normalized.get("updated_at")),
                    "kind": "handoff_ready",
                    "message": _text(normalized.get("user_safe_summary") or normalized.get("summary")),
                    "importance": "high",
                }
            )
        elif _text(state_model.get("outcome_state")).lower() == "blocked":
            events.append(
                {
                    "time": _text(normalized.get("result_ready_at") or normalized.get("completed_at") or normalized.get("updated_at")),
                    "kind": "result_blocked",
                    "message": _text(normalized.get("blocked_reason") or normalized.get("summary")),
                    "importance": "high",
                }
            )
        if normalized.get("review_required"):
            events.append(
                {
                    "time": _text(normalized.get("updated_at")),
                    "kind": "review_requested",
                    "message": "Review required",
                    "importance": "high",
                }
            )
        if artifacts:
            events.append(
                {
                    "time": _text(normalized.get("updated_at") or normalized.get("completed_at")),
                    "kind": "artifact_ready",
                    "message": f"{len(artifacts)} artifact(s) available",
                    "importance": "normal",
                }
            )

    return {
        "task_id": anchor["task_id"],
        "summary": anchor["summary"],
        "state": anchor["state"],
        "lineage": {
            "parent_task_id": _text(normalized.get("parent_id")),
            "child_task_ids": [_text(item.get("id")) for item in children],
            "active_child_count": sum(1 for item in children if task_queue_bucket(item) in ACTIVE_STATES),
            "completed_child_count": sum(1 for item in children if task_is_recent_final(item)),
        },
        "models": {
            "main_model": anchor["active_models"][0] if anchor["active_models"] else "",
            "active_models": anchor["active_models"],
            "model_health_summary": _text(normalized.get("model_health_summary")),
        },
        "artifacts": artifacts,
        "events": events,
        "task_event_summary": normalized.get("task_event_summary", {}),
        "anchor": anchor,
    }


def build_task_queue_view(tasks: list[dict[str, Any]], *, now: datetime | None = None) -> dict[str, Any]:
    anchors = [build_task_anchor(task, now=now) for task in tasks if isinstance(task, dict)]
    return {
        "running": [anchor for anchor in anchors if _text(anchor.get("queue_bucket")).lower() in RUNNING_STATES],
        "queued": [anchor for anchor in anchors if _text(anchor.get("queue_bucket")).lower() in QUEUE_STATES],
        "blocked": [anchor for anchor in anchors if _text(anchor.get("queue_bucket")).lower() in BLOCKED_STATES],
        "recently_completed": [anchor for anchor in anchors if _text(anchor.get("queue_bucket")).lower() == "recently_completed"],
    }


def build_operator_task_surface(task: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    normalized = _normalize_task(task)
    anchor = build_task_anchor(normalized, now=now)
    actions = build_task_actions(normalized)
    return {
        "schema_version": "octoclaw.task_display/v1",
        "task_anchor": anchor,
        "task_actions": actions,
        "interactive": build_task_interactive_payload(normalized, anchor=anchor, actions=actions),
        "text_fallback": render_task_anchor_text(anchor, actions),
    }


def render_task_anchor_text(anchor: dict[str, Any], actions: list[dict[str, Any]] | None = None) -> str:
    title = _text(anchor.get("title")) or _text(anchor.get("task_id"))
    emoji = _text(anchor.get("worker_pool_emoji")) or "🤖"
    worker_name = _text(anchor.get("worker_pool_display")) or _text(anchor.get("worker_pool")) or "task"
    state = _text(anchor.get("state_label")) or _state_label(_text(anchor.get("state")))
    route = _text(anchor.get("route"))
    summary = _text(anchor.get("summary"))
    model_summary = _text(anchor.get("model_summary"))
    duration = _text(anchor.get("duration"))
    queue_position = anchor.get("queue_position")

    lines = [
        f"{emoji} OctoClaw task: {title}",
        f"State: {state} | Route: {route or '?'} | Pool: {worker_name}",
    ]
    if model_summary or duration:
        meta_bits = []
        if model_summary:
            meta_bits.append(f"Model: {model_summary}")
        if duration:
            meta_bits.append(f"Elapsed: {duration}")
        if meta_bits:
            lines.append(" | ".join(meta_bits))
    if queue_position is not None:
        lines.append(f"Queue position: {queue_position}")
    if summary:
        lines.append(summary)

    enabled_actions = [item for item in (actions or []) if isinstance(item, dict) and bool(item.get("enabled", False))]
    fallback_commands = [
        action_command_value(_text(anchor.get("task_id")), str(item.get("fallback_command", "") or ""))
        for item in enabled_actions
        if str(item.get("fallback_command", "") or "").strip()
    ]
    if fallback_commands:
        lines.append("Reply with: " + " / ".join(fallback_commands))
    return "\n".join(lines)


def render_task_anchor_slack(anchor: dict[str, Any], actions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    title = _text(anchor.get("title")) or _text(anchor.get("task_id"))
    emoji = _text(anchor.get("worker_pool_emoji")) or ":robot_face:"
    state = _text(anchor.get("state_label")) or _state_label(_text(anchor.get("state")))
    route = _text(anchor.get("route"))
    pool = _text(anchor.get("worker_pool_display")) or _text(anchor.get("worker_pool"))
    summary = _text(anchor.get("summary"))
    model_summary = _text(anchor.get("model_summary"))

    fields = [
        {"type": "mrkdwn", "text": f"*State*\n{state}"},
        {"type": "mrkdwn", "text": f"*Route*\n{route or '?'}"},
        {"type": "mrkdwn", "text": f"*Pool*\n{pool or '?'}"},
    ]
    if model_summary:
        fields.append({"type": "mrkdwn", "text": f"*Model*\n{model_summary}"})

    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"{emoji} *OctoClaw task*: {title}"},
        },
        {
            "type": "section",
            "fields": fields[:10],
        },
    ]
    if summary:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": summary},
            }
        )

    enabled_actions = [item for item in (actions or []) if isinstance(item, dict) and bool(item.get("enabled", False))]
    if enabled_actions:
        elements: list[dict[str, Any]] = []
        for item in enabled_actions[:5]:
            label = _text(item.get("label")) or _text(item.get("kind")) or "Action"
            command = _text(item.get("fallback_command")) or _text(item.get("kind"))
            style = "danger" if bool(item.get("danger", False)) else "primary" if command in {"view", "details"} else None
            button: dict[str, Any] = {
                "type": "button",
                "text": {"type": "plain_text", "text": label[:75]},
                "value": command[:200],
                "action_id": _text(item.get("id"))[:255] or command[:255] or "action",
            }
            if style:
                button["style"] = style
            elements.append(button)
        if elements:
            blocks.append({"type": "actions", "elements": elements})

    fallback = render_task_anchor_text(anchor, actions)
    return {
        "text": fallback,
        "blocks": blocks,
    }
