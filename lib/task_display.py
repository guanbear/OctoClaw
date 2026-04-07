#!/usr/bin/env python3
"""Shared task display adapter and renderers for Phase 5A."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any

try:
    from im_display_contract import action_contract, ownership_for_surface, substrate_display_contract
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.im_display_contract import action_contract, ownership_for_surface, substrate_display_contract

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


def _int_or_zero(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    text = _text(value)
    if not text:
        return 0
    try:
        return int(text)
    except ValueError:
        return 0


def _taskflow_binding(task: dict[str, Any]) -> dict[str, Any]:
    explicit = dict(task.get("openclaw_taskflow", {})) if isinstance(task.get("openclaw_taskflow"), dict) else {}
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    artifact_binding = dict(artifacts.get("openclaw_taskflow", {})) if isinstance(artifacts.get("openclaw_taskflow"), dict) else {}
    merged = dict(artifact_binding)
    for key, value in explicit.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def _taskflow_substrate_summary(binding: dict[str, Any]) -> str:
    if not isinstance(binding, dict) or not binding:
        return ""
    backend = _text(binding.get("backend")) or "mirror"
    substrate_state = _text(binding.get("substrate_state"))
    substrate_revision = binding.get("substrate_revision")
    native_state = _text(binding.get("native_binding_state"))
    native_status = _text(binding.get("native_status"))
    task_id = _text(binding.get("task_id"))
    flow_id = _text(binding.get("flow_id"))
    binding_state = _text(binding.get("binding_state"))

    if backend == "managed":
        substrate_label = "managed flow"
    elif backend == "mirror" and (flow_id or task_id or native_state == "bound" or binding_state in {"mirrored_bound", "bound"}):
        substrate_label = "mirror bound to native"
    elif backend == "mirror":
        substrate_label = "legacy mirror only"
    elif backend == "native":
        substrate_label = "native task"
    else:
        substrate_label = backend.replace("_", " ")

    state_value = substrate_state or native_status or native_state or binding_state
    if substrate_label == "legacy mirror only" and state_value in {"", "mirrored", "none"}:
        state_value = ""
    if state_value == "queued" and substrate_label == "mirror bound to native":
        state_value = "bound"
    state_label = {
        "queued": "queued",
        "running": "running",
        "waiting": "waiting",
        "blocked": "blocked",
        "failed": "failed",
        "cancelled": "cancelled",
        "succeeded": "completed",
        "done": "completed",
        "completed": "completed",
        "bound": "bound",
        "mirrored_bound": "bound",
        "mirrored": "waiting for native bind",
    }.get(state_value, state_value.replace("_", " ") if state_value else "")

    parts = [substrate_label]
    if state_label and state_label != substrate_label:
        parts.append(state_label)
    revision = _int_or_zero(substrate_revision)
    if str(substrate_revision or "").strip() and revision >= 0:
        parts.append(f"rev {revision}")
    if flow_id:
        parts.append(f"flow {flow_id}")
    elif task_id:
        parts.append(f"task {task_id}")
    return " · ".join(parts)


def _substrate_preferred_state(task: dict[str, Any], binding: dict[str, Any], fallback_state: str) -> str:
    if not isinstance(binding, dict) or not binding:
        return fallback_state
    substrate_state = _text(task.get("openclaw_taskflow_substrate_state") or binding.get("substrate_state")).lower()
    sync_mode = _text(task.get("openclaw_taskflow_sync_mode") or binding.get("sync_mode")).lower()
    native_binding_state = _text(task.get("openclaw_native_binding_state") or binding.get("native_binding_state")).lower()
    mapped = {
        "queued": "queued",
        "running": "running",
        "waiting": "blocked",
        "blocked": "blocked",
        "failed": "failed",
        "cancelled": "cancelled",
        "succeeded": "done",
    }.get(substrate_state, "")
    if not mapped:
        return fallback_state
    if native_binding_state == "bound" or sync_mode == "managed":
        return mapped
    return fallback_state


def _create_path_summary(create_preference: str, create_status: str) -> str:
    preference = _text(create_preference)
    status = _text(create_status)
    if not preference and not status:
        return ""
    return " | ".join(
        part
        for part in [
            f"preference {preference}" if preference else "",
            f"status {status}" if status else "",
        ]
        if part
    )


def _substrate_read_target(substrate: dict[str, Any], *, fallback_task_id: str = "") -> str:
    flow_id = _text(substrate.get("flow_id"))
    task_id = _text(substrate.get("task_id"))
    if flow_id:
        return f"TaskFlow flow {flow_id}"
    if task_id:
        return f"TaskFlow task {task_id}"
    if fallback_task_id:
        return f"OctoClaw task {fallback_task_id}"
    return ""


def _build_review_surface(
    task: dict[str, Any],
    children: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    review_children = [
        item
        for item in children
        if _text(item.get("worker_pool")).lower() == "octoclaw-review"
        or _text(item.get("work_type")).lower() == "review"
        or _text(item.get("phase")).lower() == "verify"
    ]
    if review_children:
        review_child = sorted(
            review_children,
            key=lambda item: (
                0 if task_queue_bucket(item) in ACTIVE_STATES else 1,
                _text(item.get("updated_at")) or _text(item.get("started_at")) or _text(item.get("id")),
            ),
        )[0]
        anchor = build_task_anchor(review_child, now=now)
        create_path = _create_path_summary(
            _text(anchor.get("openclaw_create_preference")),
            _text(anchor.get("openclaw_create_status")),
        )
        return {
            "required": True,
            "surface_state": "child_task",
            "state": _text(anchor.get("state")),
            "state_label": _text(anchor.get("state_label")),
            "task_id": _text(anchor.get("task_id")),
            "route": _text(anchor.get("route")),
            "worker_pool": _text(anchor.get("worker_pool")),
            "substrate_summary": _text(anchor.get("substrate_summary")),
            "create_path": create_path,
            "action_hint": action_command_value(_text(anchor.get("task_id")), "details"),
        }
    if task.get("review_required"):
        return {
            "required": True,
            "surface_state": "required",
            "state": "needs_review",
            "state_label": "Review required",
            "task_id": "",
            "route": "",
            "worker_pool": "octoclaw-review",
            "substrate_summary": "",
            "create_path": "",
            "action_hint": action_command_value(_text(task.get("id")), "details"),
        }
    return {
        "required": False,
        "surface_state": "not_required",
        "state": "",
        "state_label": "",
        "task_id": "",
        "route": "",
        "worker_pool": "",
        "substrate_summary": "",
        "create_path": "",
        "action_hint": "",
    }


def action_command_value(task_id: str, fallback_command: str) -> str:
    command = _text(fallback_command)
    task_ref = _text(task_id)
    return f"{command} {task_ref}".strip() if command else ""


def _normalize_task(task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {}
    preview_events = [event for event in task.get("task_events_preview", []) if isinstance(event, dict)] if isinstance(task.get("task_events_preview"), list) else []
    event_summary = dict(task.get("task_event_summary", {})) if isinstance(task.get("task_event_summary"), dict) else {}
    if _text(task.get("schema_version")).startswith("octoclaw.runtime_task.record/"):
        normalized = dict(task)
        if preview_events:
            normalized["task_events_preview"] = preview_events
        if event_summary:
            normalized["task_event_summary"] = event_summary
        return normalized
    try:
        from runtime_task_record import normalize_task_record
    except ModuleNotFoundError:  # pragma: no cover - package import path for tests
        from lib.runtime_task_record import normalize_task_record
    normalized = normalize_task_record(task)
    if preview_events:
        normalized["task_events_preview"] = preview_events
    if event_summary:
        normalized["task_event_summary"] = event_summary
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


def _event_time_value(event: dict[str, Any]) -> datetime | None:
    if not isinstance(event, dict):
        return None
    for key in ("time", "at", "updated_at", "completed_at", "started_at"):
        parsed = _parse_time(_text(event.get(key)))
        if parsed:
            return parsed
    return None


def _event_time_label(event: dict[str, Any]) -> str:
    parsed = _event_time_value(event)
    if not parsed:
        return ""
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


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
    if lifecycle in {"finished", "cancelled"} and outcome == "done" and handoff == "delivered":
        return "delivered"
    if lifecycle in {"finished", "cancelled"} and outcome == "blocked":
        if handoff == "delivered":
            return "blocked (delivered)"
        return "blocked (handoff ready)" if handoff == "user_safe_ready" else "blocked"
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
        {
            "id": "retrieve",
            "kind": "retrieve",
            "label": "Retrieve",
            "enabled": True,
            "danger": False,
            "requires_confirmation": False,
            "fallback_command": "retrieve",
        },
        {
            "id": "timeline",
            "kind": "timeline",
            "label": "Timeline",
            "enabled": True,
            "danger": False,
            "requires_confirmation": False,
            "fallback_command": "timeline",
        },
        {
            "id": "graph",
            "kind": "graph",
            "label": "Graph",
            "enabled": True,
            "danger": False,
            "requires_confirmation": False,
            "fallback_command": "graph",
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
        actions.append(
            {
                "id": "explorer",
                "kind": "explorer",
                "label": "Explorer",
                "enabled": True,
                "danger": False,
                "requires_confirmation": False,
                "fallback_command": "explorer",
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

    for item in actions:
        contract = action_contract(_text(item.get("id")) or _text(item.get("kind")))
        item["action_class"] = _text(contract.get("class")) or "observe"
        item["replay_safe"] = bool(contract.get("replay_safe", True))
    return actions


def _action_availability(actions: list[dict[str, Any]]) -> list[str]:
    available: list[str] = []
    for item in actions:
        if not isinstance(item, dict):
            continue
        if not bool(item.get("enabled", False)):
            continue
        action_id = _text(item.get("id")) or _text(item.get("kind"))
        if action_id and action_id not in available:
            available.append(action_id)
    return available


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
    taskflow = _taskflow_binding(normalized)
    if _text(lifecycle_state).lower() not in {"finished", "cancelled"}:
        state = _substrate_preferred_state(normalized, taskflow, state)

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
        "checklist_kind": _text(((normalized.get("checklist") or {}) if isinstance(normalized.get("checklist"), dict) else {}).get("kind")),
        "checklist_open_count": int((((normalized.get("checklist") or {}) if isinstance(normalized.get("checklist"), dict) else {}).get("open_count", 0) or 0)),
        "checklist_completed_count": int((((normalized.get("checklist") or {}) if isinstance(normalized.get("checklist"), dict) else {}).get("completed_count", 0) or 0)),
        "phase": _text(normalized.get("phase")),
        "profile": _text(normalized.get("profile")),
        "eta": _text(normalized.get("expected_done_at")),
        "queue_position": normalized.get("queue_position") if isinstance(normalized.get("queue_position"), int) else None,
        "cost_estimate": _text(normalized.get("cost_estimate")),
        "active_models": models,
        "model_summary": ", ".join(models[:2]) + ("…" if len(models) > 2 else "") if models else "",
        "started_at": _text(normalized.get("started_at")),
        "updated_at": _text(normalized.get("updated_at")),
        "result_ready_at": _text(normalized.get("result_ready_at")),
        "handoff_ready_at": _text(normalized.get("handoff_ready_at")),
        "delivered_at": _text(normalized.get("delivered_at")),
        "duration": _duration_label(_text(normalized.get("started_at")), now=now),
        "openclaw_taskflow_backend": _text(normalized.get("openclaw_taskflow_backend") or taskflow.get("backend")),
        "openclaw_taskflow_state": _text(normalized.get("openclaw_taskflow_state") or taskflow.get("binding_state")),
        "openclaw_task_runtime": _text(normalized.get("openclaw_task_runtime") or taskflow.get("task_runtime")),
        "openclaw_flow_runtime": _text(normalized.get("openclaw_flow_runtime") or taskflow.get("flow_runtime")),
        "openclaw_taskflow_sync_mode": _text(normalized.get("openclaw_taskflow_sync_mode") or taskflow.get("sync_mode")),
        "openclaw_taskflow_substrate_state": _text(normalized.get("openclaw_taskflow_substrate_state") or taskflow.get("substrate_state")),
        "openclaw_taskflow_substrate_revision": _int_or_zero(normalized.get("openclaw_taskflow_substrate_revision") or taskflow.get("substrate_revision")),
        "openclaw_native_binding_state": _text(taskflow.get("native_binding_state")),
        "openclaw_native_status": _text(normalized.get("openclaw_native_status") or taskflow.get("native_status")),
        "openclaw_native_runtime": _text(normalized.get("openclaw_native_runtime") or taskflow.get("native_runtime")),
        "openclaw_native_seen_at": _text(normalized.get("openclaw_native_seen_at") or taskflow.get("native_seen_at")),
        "openclaw_native_match_score": int(normalized.get("openclaw_native_match_score") or taskflow.get("native_match_score") or 0),
        "openclaw_create_preference": _text(taskflow.get("create_preference")),
        "openclaw_create_status": _text(taskflow.get("create_status")),
        "openclaw_task_id": _text(normalized.get("openclaw_task_id") or taskflow.get("task_id")),
        "openclaw_flow_id": _text(normalized.get("openclaw_flow_id") or taskflow.get("flow_id")),
        "openclaw_flow_kind": _text(normalized.get("openclaw_flow_kind") or taskflow.get("flow_kind")),
        "substrate_summary": _taskflow_substrate_summary(taskflow),
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
    child_ids = _declared_child_ids(normalized)
    children = [item for item in all_normalized if _text(item.get("parent_id")) == task_id or _text(item.get("id")) in child_ids]
    artifacts = _collect_artifacts(normalized)
    actions = build_task_actions(normalized)
    raw_artifacts = normalized.get("artifacts", {}) if isinstance(normalized.get("artifacts"), dict) else {}
    runner_plan = dict(raw_artifacts.get("runner_plan", {})) if isinstance(raw_artifacts.get("runner_plan"), dict) else {}
    review = _build_review_surface(normalized, children, now=now)
    task_summary = {
        "child_count": len(children),
        "active_child_count": sum(1 for item in children if task_queue_bucket(item) in ACTIVE_STATES),
        "completed_child_count": sum(1 for item in children if task_is_recent_final(item)),
        "review_child_count": sum(
            1
            for item in children
            if _text(item.get("worker_pool")).lower() == "octoclaw-review"
            or _text(item.get("work_type")).lower() == "review"
            or _text(item.get("phase")).lower() == "verify"
        ),
    }
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
        if _text(state_model.get("handoff_state")).lower() == "delivered":
            events.append(
                {
                    "time": _text(normalized.get("delivered_at") or normalized.get("updated_at") or normalized.get("completed_at")),
                    "kind": "user_notified",
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
        "substrate": {
            "backend": _text(anchor.get("openclaw_taskflow_backend")),
            "state": _text(anchor.get("openclaw_taskflow_state")),
            "task_runtime": _text(anchor.get("openclaw_task_runtime")),
            "flow_runtime": _text(anchor.get("openclaw_flow_runtime")),
            "sync_mode": _text(anchor.get("openclaw_taskflow_sync_mode")),
            "substrate_state": _text(anchor.get("openclaw_taskflow_substrate_state")),
            "substrate_revision": _int_or_zero(anchor.get("openclaw_taskflow_substrate_revision")),
            "native_binding_state": _text(anchor.get("openclaw_native_binding_state")),
            "native_status": _text(anchor.get("openclaw_native_status")),
            "native_runtime": _text(anchor.get("openclaw_native_runtime")),
            "native_seen_at": _text(anchor.get("openclaw_native_seen_at")),
            "native_match_score": int(anchor.get("openclaw_native_match_score") or 0),
            "create_preference": _text(anchor.get("openclaw_create_preference")),
            "create_status": _text(anchor.get("openclaw_create_status")),
            "task_id": _text(anchor.get("openclaw_task_id")),
            "flow_id": _text(anchor.get("openclaw_flow_id")),
            "flow_kind": _text(anchor.get("openclaw_flow_kind")),
            "summary": _text(anchor.get("substrate_summary")),
        },
        "lineage": {
            "parent_task_id": _text(normalized.get("parent_id")),
            "child_task_ids": [_text(item.get("id")) for item in children],
            "active_child_count": task_summary["active_child_count"],
            "completed_child_count": task_summary["completed_child_count"],
        },
        "models": {
            "main_model": anchor["active_models"][0] if anchor["active_models"] else "",
            "active_models": anchor["active_models"],
            "model_health_summary": _text(normalized.get("model_health_summary")),
        },
        "artifacts": artifacts,
        "action_availability": _action_availability(actions),
        "substrate_display_contract": substrate_display_contract(),
        "runner_plan": runner_plan,
        "review": review,
        "task_summary": task_summary,
        "checklist": normalized.get("checklist", {}) if isinstance(normalized.get("checklist"), dict) else {},
        "events": events,
        "task_event_summary": normalized.get("task_event_summary", {}),
        "anchor": anchor,
    }


def _task_map(tasks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {_text(item.get("id")): item for item in tasks if _text(item.get("id"))}


def _declared_child_ids(task: dict[str, Any]) -> list[str]:
    child_ids = _text_list(task.get("child_ids"))
    if child_ids:
        return child_ids
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    child_ids = _text_list(artifacts.get("child_task_ids"))
    if child_ids:
        return child_ids
    step_task_ids = artifacts.get("step_task_ids", {}) if isinstance(artifacts.get("step_task_ids", {}), dict) else {}
    seen: set[str] = set()
    ordered: list[str] = []
    for value in step_task_ids.values():
        child_id = _text(value)
        if child_id and child_id not in seen:
            seen.add(child_id)
            ordered.append(child_id)
    return ordered


def _linear_step_pairs(task: dict[str, Any]) -> list[tuple[str, str]]:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    step_order = artifacts.get("step_order", []) if isinstance(artifacts.get("step_order", []), list) else []
    step_task_ids = artifacts.get("step_task_ids", {}) if isinstance(artifacts.get("step_task_ids", {}), dict) else {}
    ordered_task_ids = [_text(step_task_ids.get(step)) for step in step_order if _text(step_task_ids.get(step))]
    pairs: list[tuple[str, str]] = []
    for idx in range(len(ordered_task_ids) - 1):
        source = ordered_task_ids[idx]
        target = ordered_task_ids[idx + 1]
        if source and target and source != target:
            pairs.append((source, target))
    return pairs


def _root_task_for(task: dict[str, Any], tasks_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    current = task
    seen: set[str] = set()
    while True:
        current_id = _text(current.get("id"))
        parent_id = _text(current.get("parent_id"))
        if not parent_id or parent_id in seen:
            return current
        parent = tasks_by_id.get(parent_id)
        if not isinstance(parent, dict):
            return current
        seen.add(current_id)
        current = parent


def build_task_graph(
    task: dict[str, Any],
    *,
    all_tasks: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    all_normalized = [_normalize_task(item) for item in (all_tasks or []) if isinstance(item, dict)]
    if not all_normalized:
        all_normalized = [_normalize_task(task)]
    tasks_by_id = _task_map(all_normalized)
    normalized = _normalize_task(task)
    root = _root_task_for(normalized, tasks_by_id)
    root_id = _text(root.get("id"))

    children_by_parent: dict[str, list[dict[str, Any]]] = {}
    declared_children_by_task: dict[str, list[str]] = {}
    linear_step_pairs_by_task: dict[str, list[tuple[str, str]]] = {}
    for item in all_normalized:
        current_id = _text(item.get("id"))
        if current_id:
            declared_children_by_task[current_id] = _declared_child_ids(item)
            linear_step_pairs_by_task[current_id] = _linear_step_pairs(item)
        parent_id = _text(item.get("parent_id"))
        if not parent_id:
            continue
        children_by_parent.setdefault(parent_id, []).append(item)

    ordered_ids: list[str] = []
    edges: list[dict[str, str]] = []
    seen_edges: set[tuple[str, str, str]] = set()
    queue: list[str] = [root_id] if root_id else [_text(normalized.get("id"))]
    seen: set[str] = set()
    while queue:
        current_id = queue.pop(0)
        if not current_id or current_id in seen:
            continue
        current = tasks_by_id.get(current_id)
        if not isinstance(current, dict):
            continue
        seen.add(current_id)
        ordered_ids.append(current_id)
        for child in sorted(children_by_parent.get(current_id, []), key=lambda item: _text(item.get("started_at") or item.get("updated_at") or item.get("id"))):
            child_id = _text(child.get("id"))
            if not child_id:
                continue
            edge_key = (current_id, child_id, "child")
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append({"source": current_id, "target": child_id, "relation": "child"})
            queue.append(child_id)
        for child_id in declared_children_by_task.get(current_id, []):
            child = tasks_by_id.get(child_id)
            if not isinstance(child, dict):
                continue
            edge_key = (current_id, child_id, "child")
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append({"source": current_id, "target": child_id, "relation": "child"})
            queue.append(child_id)

    if _text(normalized.get("id")) not in ordered_ids and _text(normalized.get("id")):
        ordered_ids.append(_text(normalized.get("id")))

    for owner_id, pairs in linear_step_pairs_by_task.items():
        if owner_id not in ordered_ids:
            continue
        for source, target in pairs:
            if source not in ordered_ids:
                ordered_ids.append(source)
            if target not in ordered_ids:
                ordered_ids.append(target)
            edge_key = (source, target, "linear_step")
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append({"source": source, "target": target, "relation": "linear_step"})

    nodes = [build_task_anchor(tasks_by_id.get(task_id, normalized), now=now) for task_id in ordered_ids]
    route_counts = Counter(_text(node.get("route")) for node in nodes if _text(node.get("route")))
    worker_pool_counts = Counter(_text(node.get("worker_pool")) for node in nodes if _text(node.get("worker_pool")))
    queue_counts = Counter(_text(node.get("queue_bucket")) for node in nodes if _text(node.get("queue_bucket")))
    return {
        "task_id": _text(normalized.get("id")),
        "root_task_id": root_id,
        "current_task_id": _text(normalized.get("id")),
        "nodes": nodes,
        "edges": edges,
        "summary": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "active_count": sum(1 for node in nodes if _text(node.get("queue_bucket")) in ACTIVE_STATES),
            "blocked_count": sum(1 for node in nodes if _text(node.get("queue_bucket")) in BLOCKED_STATES),
            "terminal_count": sum(1 for node in nodes if bool(node.get("terminal"))),
            "route_counts": dict(sorted(route_counts.items())),
            "worker_pool_counts": dict(sorted(worker_pool_counts.items())),
            "queue_counts": dict(sorted(queue_counts.items())),
        },
    }


def build_task_timeline(
    task: dict[str, Any],
    *,
    all_tasks: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    normalized = _normalize_task(task)
    detail = build_task_detail(normalized, all_tasks=all_tasks, now=now)
    graph = build_task_graph(normalized, all_tasks=all_tasks, now=now)
    all_normalized = [_normalize_task(item) for item in (all_tasks or []) if isinstance(item, dict)]
    tasks_by_id = _task_map(all_normalized)

    events: list[dict[str, Any]] = []
    for event in detail.get("events", []) if isinstance(detail.get("events"), list) else []:
        if not isinstance(event, dict):
            continue
        events.append(
            {
                "time": _event_time_label(event),
                "kind": _text(event.get("kind")),
                "task_id": _text(normalized.get("id")),
                "source": "task",
                "importance": _text(event.get("importance")) or "normal",
                "message": _text(event.get("message")),
            }
        )

    seen_child_started: set[str] = set()
    seen_child_finished: set[str] = set()
    for edge in graph.get("edges", []) if isinstance(graph.get("edges"), list) else []:
        if not isinstance(edge, dict):
            continue
        child_id = _text(edge.get("target"))
        child = tasks_by_id.get(child_id)
        if not isinstance(child, dict):
            continue
        child_anchor = build_task_anchor(child, now=now)
        child_title = _text(child_anchor.get("title")) or child_id
        started_at = _text(child.get("started_at"))
        if started_at and child_id not in seen_child_started:
            seen_child_started.add(child_id)
            events.append(
                {
                    "time": _event_time_label({"time": started_at}),
                    "kind": "child_started",
                    "task_id": child_id,
                    "source": "graph",
                    "importance": "normal",
                    "message": f"{child_title} started via {child_anchor.get('route', '') or '?'}",
                }
            )
        final_time = _text(child.get("completed_at") or child.get("updated_at"))
        if child_anchor.get("terminal") and final_time and child_id not in seen_child_finished:
            seen_child_finished.add(child_id)
            final_kind = "child_finished"
            state = _text(child_anchor.get("state"))
            if state == "failed":
                final_kind = "child_failed"
            elif state == "blocked":
                final_kind = "child_blocked"
            elif state == "partial":
                final_kind = "child_partial"
            events.append(
                {
                    "time": _event_time_label({"time": final_time}),
                    "kind": final_kind,
                    "task_id": child_id,
                    "source": "graph",
                    "importance": "high" if final_kind in {"child_failed", "child_blocked"} else "normal",
                    "message": f"{child_title} {child_anchor.get('state_label', state or 'finished')}",
                }
            )

    events.sort(key=lambda item: (_event_time_value(item) or datetime.min.replace(tzinfo=timezone.utc), _text(item.get("kind")), _text(item.get("task_id"))))
    kind_counts = Counter(_text(item.get("kind")) for item in events if _text(item.get("kind")))
    source_counts = Counter(_text(item.get("source")) for item in events if _text(item.get("source")))
    return {
        "task_id": _text(normalized.get("id")),
        "root_task_id": _text(graph.get("root_task_id")),
        "events": events,
        "summary": {
            "event_count": len(events),
            "kind_counts": dict(sorted(kind_counts.items())),
            "source_counts": dict(sorted(source_counts.items())),
        },
    }


def build_task_artifact_explorer(
    task: dict[str, Any],
    *,
    all_tasks: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    bundle = build_task_retrieval_bundle(task, all_tasks=all_tasks, now=now)
    primary = bundle.get("primary_artifacts", []) if isinstance(bundle.get("primary_artifacts"), list) else []
    related = bundle.get("related_thread_artifacts", []) if isinstance(bundle.get("related_thread_artifacts"), list) else []
    by_kind = Counter(_text(item.get("kind")) for item in [*primary, *related] if isinstance(item, dict) and _text(item.get("kind")))
    thread_task_ids = sorted({_text(item.get("task_id")) for item in related if isinstance(item, dict) and _text(item.get("task_id"))})
    return {
        "task_id": _text(bundle.get("task_id")),
        "summary": _text(bundle.get("user_safe_summary") or bundle.get("summary")),
        "primary_report": _text(bundle.get("primary_report")),
        "context_path": _text(bundle.get("context_path")),
        "context_pack_path": _text(bundle.get("context_pack_path")),
        "recommended_read_order": bundle.get("recommended_read_order", []) if isinstance(bundle.get("recommended_read_order"), list) else [],
        "primary_artifacts": primary,
        "related_thread_artifacts": related,
        "by_kind": dict(sorted(by_kind.items())),
        "thread_task_ids": thread_task_ids,
    }


def build_task_retrieval_bundle(
    task: dict[str, Any],
    *,
    all_tasks: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    detail = build_task_detail(task, all_tasks=all_tasks, now=now)
    normalized = _normalize_task(task)
    artifacts = detail.get("artifacts", []) if isinstance(detail.get("artifacts"), list) else []
    primary = [item for item in artifacts if isinstance(item, dict) and not bool(item.get("related_to_thread"))]
    related = [item for item in artifacts if isinstance(item, dict) and bool(item.get("related_to_thread"))]
    worker_result = ((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("worker_result")
    runner_plan = ((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("runner_plan")
    next_step = _text(worker_result.get("next_step")) if isinstance(worker_result, dict) else ""
    user_safe_summary = _text(worker_result.get("user_safe_summary")) if isinstance(worker_result, dict) else ""
    primary_report = _text(normalized.get("report_path")) or _text(((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("report_path"))
    substrate = detail.get("substrate", {}) if isinstance(detail.get("substrate"), dict) else {}
    review = detail.get("review", {}) if isinstance(detail.get("review"), dict) else {}
    task_summary = detail.get("task_summary", {}) if isinstance(detail.get("task_summary"), dict) else {}
    create_path = _create_path_summary(_text(substrate.get("create_preference")), _text(substrate.get("create_status")))
    recommended_read_order: list[str] = []
    substrate_summary = _text(substrate.get("summary"))
    substrate_target = _substrate_read_target(substrate, fallback_task_id=_text(normalized.get("id")))
    if substrate_target:
        recommended_read_order.append(substrate_target)
    if substrate_summary:
        recommended_read_order.append(f"substrate summary: {substrate_summary}")
    if create_path:
        recommended_read_order.append(f"create path: {create_path}")
    if int(task_summary.get("child_count", 0) or 0):
        recommended_read_order.append(
            "task summary: "
            + " · ".join(
                [
                    f"{int(task_summary.get('active_child_count', 0) or 0)} active child",
                    f"{int(task_summary.get('completed_child_count', 0) or 0)} completed child",
                ]
            )
        )
    if bool(review.get("required")):
        review_label = _text(review.get("state_label")) or "Review required"
        if _text(review.get("task_id")):
            recommended_read_order.append(f"review surface: {review_label} via {_text(review.get('task_id'))}")
        else:
            recommended_read_order.append(f"review surface: {review_label}")
    recommended_read_order.extend(
        [
            item
            for item in [
                primary_report,
                _text(((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("context_pack_path")),
                _text(normalized.get("context_path")),
            ]
            if item
        ]
    )
    return {
        "task_id": _text(normalized.get("id")),
        "summary": _clean_task_summary(normalized, limit=160),
        "user_safe_summary": user_safe_summary or _text(normalized.get("user_safe_summary")),
        "next_step": next_step,
        "state": _text(detail.get("state")),
        "route": _text(normalized.get("route")),
        "worker_pool": _text(normalized.get("worker_pool")),
        "substrate": substrate,
        "review": review,
        "task_summary": task_summary,
        "primary_report": primary_report,
        "context_path": _text(normalized.get("context_path")) or _text(((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("context_path")),
        "context_pack_path": _text(((normalized.get("artifacts") or {}) if isinstance(normalized.get("artifacts"), dict) else {}).get("context_pack_path")),
        "runner_plan": dict(runner_plan) if isinstance(runner_plan, dict) else {},
        "checklist": detail.get("checklist", {}) if isinstance(detail.get("checklist"), dict) else {},
        "primary_artifacts": primary[:5],
        "related_thread_artifacts": related[:5],
        "recommended_read_order": recommended_read_order,
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
        "surface_role": ownership_for_surface("cli"),
        "task_anchor": anchor,
        "task_actions": actions,
        "action_availability": _action_availability(actions),
        "interactive": build_task_interactive_payload(normalized, anchor=anchor, actions=actions),
        "substrate_display_contract": substrate_display_contract(),
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
    substrate_summary = _text(anchor.get("substrate_summary"))
    create_path = _create_path_summary(_text(anchor.get("openclaw_create_preference")), _text(anchor.get("openclaw_create_status")))

    lines = [
        f"{emoji} OctoClaw task: {title}",
    ]
    if substrate_summary:
        lines.append(f"Substrate: {substrate_summary}")
    if create_path:
        lines.append(f"Create path: {create_path}")
    lines.append(f"State: {state} | Route: {route or '?'} | Pool: {worker_name}")
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
    checklist_open_count = int(anchor.get("checklist_open_count") or 0)
    checklist_completed_count = int(anchor.get("checklist_completed_count") or 0)
    if checklist_open_count or checklist_completed_count:
        lines.append(f"Checklist: {checklist_completed_count} done / {checklist_open_count} open")
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
    substrate_summary = _text(anchor.get("substrate_summary"))
    create_path = _create_path_summary(_text(anchor.get("openclaw_create_preference")), _text(anchor.get("openclaw_create_status")))

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
    if substrate_summary or create_path:
        substrate_bits = []
        if substrate_summary:
            substrate_bits.append(f"*Substrate*\n{substrate_summary}")
        if create_path:
            substrate_bits.append(f"*Create path*\n{create_path}")
        blocks.append(
            {
                "type": "section",
                "fields": [{"type": "mrkdwn", "text": item} for item in substrate_bits[:10]],
            }
        )
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
