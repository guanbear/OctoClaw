#!/usr/bin/env python3
"""Shared runtime task record helpers for OctoClaw."""

from __future__ import annotations

from typing import Any

try:
    from octopus_config import infer_session_origin
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import infer_session_origin

try:
    from task_events import session_binding_from_route, task_event_snapshot
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_events import session_binding_from_route, task_event_snapshot

try:
    from worker_taxonomy import resolve_executor, resolve_model_band, resolve_phase, resolve_work_type, resolve_worker_pool
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.worker_taxonomy import resolve_executor, resolve_model_band, resolve_phase, resolve_work_type, resolve_worker_pool

try:
    from runtime_protocol import (
        normalize_capability_bound_failure,
        normalize_delegated_materialization,
        normalize_result_status,
        normalize_worker_result,
    )
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_protocol import (
        normalize_capability_bound_failure,
        normalize_delegated_materialization,
        normalize_result_status,
        normalize_worker_result,
    )

try:
    from runtime_coordination import ownership_snapshot, resolve_task_checklist, session_resume_snapshot
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_coordination import ownership_snapshot, resolve_task_checklist, session_resume_snapshot


TASK_RECORD_SCHEMA_VERSION = "octoclaw.runtime_task.record/v1"
LIFECYCLE_STATES = {"planned", "queued", "running", "finalizing", "finished", "cancelled"}
OUTCOME_STATES = {"pending", "done", "blocked", "failed", "partial", "cancelled"}
HANDOFF_STATES = {"none", "internal_only", "user_safe_ready", "delivered"}
FINAL_LIFECYCLE_STATES = {"finished", "cancelled"}
READY_OUTCOME_STATES = {"done", "blocked", "partial"}


def compact_text(text: str, limit: int = 120) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _normalized_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _normalized_str(value: Any) -> str:
    return str(value or "").strip()


def _normalized_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "on"}


def _normalized_choice(value: Any, allowed: set[str]) -> str:
    text = _normalized_str(value).lower()
    return text if text in allowed else ""


def _normalized_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    text = _normalized_str(value)
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


def infer_managed_by_octoclaw(task: dict[str, Any]) -> bool:
    explicit = task.get("managed_by_octoclaw")
    if explicit is not None and str(explicit).strip() != "":
        return _normalized_bool(explicit)
    source = _normalized_str(task.get("source")).lower()
    worker_pool = _normalized_str(task.get("worker_pool")).lower()
    route = _normalized_str(task.get("route")).lower()
    return source in {"octoclaw", "octopus"} or worker_pool.startswith("octoclaw-") or route in {"runner", "spawn_single", "spawn_multi", "direct"}


def infer_agent_namespace(task: dict[str, Any], managed: bool) -> str:
    explicit = _normalized_str(task.get("agent_namespace"))
    if explicit:
        return explicit
    return "octoclaw" if managed else ""


def infer_agent_id(task: dict[str, Any]) -> str:
    return _normalized_str(task.get("agent_id")) or _normalized_str(task.get("owner"))


def infer_executor(task: dict[str, Any]) -> str:
    resolved = str(resolve_executor(task) or "").strip()
    return resolved


def infer_executor_type(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("executor_type"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    executor = infer_executor(task)
    if route == "runner" or executor == "runner":
        return "runner"
    if route == "spawn_multi":
        return "team"
    if route == "spawn_single" or executor == "subagent":
        return "subagent"
    if route == "direct":
        return "main"
    return "unknown"


def infer_work_type(task: dict[str, Any]) -> str:
    return _normalized_str(resolve_work_type(task))


def infer_phase(task: dict[str, Any], work_type: str) -> str:
    candidate = dict(task)
    if work_type and not _normalized_str(candidate.get("work_type")):
        candidate["work_type"] = work_type
    return _normalized_str(resolve_phase(candidate))


def infer_worker_pool(task: dict[str, Any], work_type: str) -> str:
    candidate = dict(task)
    if work_type and not _normalized_str(candidate.get("work_type")):
        candidate["work_type"] = work_type
    return _normalized_str(resolve_worker_pool(candidate))


def infer_runtime(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("runtime"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    executor = infer_executor(task)
    if route == "runner" or executor == "runner":
        return "runner"
    if route in {"spawn_single", "spawn_multi"} or executor == "subagent":
        return "subagent"
    return ""


def infer_model_band(task: dict[str, Any], work_type: str) -> str:
    candidate = dict(task)
    if work_type and not _normalized_str(candidate.get("work_type")):
        candidate["work_type"] = work_type
    return _normalized_str(resolve_model_band(candidate))


def infer_title(task: dict[str, Any]) -> str:
    for field in ("title", "task_description", "summary", "id"):
        value = compact_text(_normalized_str(task.get(field)))
        if value:
            return value
    return "untitled-task"


def merge_artifacts(task: dict[str, Any]) -> dict[str, Any]:
    raw = task.get("artifacts")
    artifacts = dict(raw) if isinstance(raw, dict) else {}
    report_path = _normalized_str(task.get("report_path"))
    context_path = _normalized_str(task.get("context_path"))
    context_summary = _normalized_str(task.get("context_summary"))
    files_changed = _normalized_list(task.get("files_changed"))

    if report_path:
        artifacts["report_path"] = report_path
    if context_path:
        artifacts["context_path"] = context_path
    if context_summary:
        artifacts["context_summary"] = context_summary
    if files_changed:
        artifacts["files_changed"] = files_changed
    delegated_materialization = normalize_delegated_materialization(
        task.get("delegated_materialization") if isinstance(task.get("delegated_materialization"), dict) else artifacts.get("delegated_materialization"),
        lane=_normalized_str(task.get("route")),
    )
    if delegated_materialization.get("lane") or delegated_materialization.get("kind"):
        artifacts["delegated_materialization"] = delegated_materialization
    capability_failure = normalize_capability_bound_failure(
        task.get("capability_failure") if isinstance(task.get("capability_failure"), dict) else artifacts.get("capability_failure"),
        lane=_normalized_str(task.get("route")),
    )
    if capability_failure.get("reason"):
        artifacts["capability_failure"] = capability_failure
    taskflow = _taskflow_binding(task)
    if taskflow:
        artifacts["openclaw_taskflow"] = taskflow

    operator_surface = artifacts.get("operator_surface")
    if isinstance(operator_surface, dict):
        try:
            from task_display import build_operator_task_surface
        except ModuleNotFoundError:  # pragma: no cover - package import path for tests
            from lib.task_display import build_operator_task_surface

        merged_surface = dict(operator_surface)
        display_surface = build_operator_task_surface(task)
        merged_surface.update(display_surface)
        artifacts["operator_surface"] = merged_surface
        artifacts["display_text"] = str(display_surface.get("text_fallback", "") or "")
    return artifacts

def _final_worker_result(task: dict[str, Any], artifacts: dict[str, Any]) -> dict[str, Any] | None:
    status = _normalized_str(task.get("status")).lower()
    existing = artifacts.get("worker_result") if isinstance(artifacts.get("worker_result"), dict) else {}
    if status not in {"done", "failed", "completed"} and not existing:
        return None

    payload = dict(existing)
    payload.setdefault("task_id", _normalized_str(task.get("id")))
    payload.setdefault("status", status or "failed")
    payload.setdefault("summary", _normalized_str(task.get("summary")))
    payload.setdefault("report", _normalized_str(task.get("report_path")))
    payload.setdefault("files", _normalized_list(task.get("files_changed")))
    if "next_step" not in payload:
        payload["next_step"] = "none" if status in {"done", "completed"} else "inspect report and decide next step"
    return normalize_worker_result(
        payload,
        task_id=_normalized_str(task.get("id")),
        default_report=_normalized_str(task.get("report_path")),
    )


def _existing_worker_result(task: dict[str, Any], artifacts: dict[str, Any]) -> dict[str, Any] | None:
    existing = artifacts.get("worker_result") if isinstance(artifacts.get("worker_result"), dict) else {}
    if existing:
        return normalize_worker_result(
            existing,
            task_id=_normalized_str(task.get("id")),
            default_report=_normalized_str(task.get("report_path")),
        )
    return None


def infer_outcome_state(task: dict[str, Any], worker_result: dict[str, Any] | None = None) -> str:
    if worker_result:
        result_status = normalize_result_status(str(worker_result.get("status", "") or ""), default="")
        if result_status == "done":
            derived = "done"
            explicit = _normalized_choice(task.get("outcome_state"), OUTCOME_STATES)
            if explicit and explicit != "pending":
                return explicit
            return derived
        if result_status == "blocked":
            derived = "blocked"
            explicit = _normalized_choice(task.get("outcome_state"), OUTCOME_STATES)
            if explicit and explicit not in {"pending", "done"}:
                return explicit
            return derived
        if result_status == "failed":
            derived = "failed"
            explicit = _normalized_choice(task.get("outcome_state"), OUTCOME_STATES)
            if explicit and explicit not in {"pending", "done", "blocked"}:
                return explicit
            return derived
    status = _normalized_str(task.get("status")).lower()
    mapping = {
        "done": "done",
        "completed": "done",
        "failed": "failed",
        "blocked": "blocked",
        "needs_approval": "blocked",
        "pending_confirm": "blocked",
        "deferred": "blocked",
        "cancelled": "cancelled",
    }
    derived = mapping.get(status, "pending")
    explicit = _normalized_choice(task.get("outcome_state"), OUTCOME_STATES)
    if explicit:
        if derived in {"done", "blocked", "failed", "cancelled", "partial"} and explicit == "pending":
            return derived
        return explicit
    return derived


def infer_lifecycle_state(task: dict[str, Any], outcome_state: str, worker_result: dict[str, Any] | None = None) -> str:
    status = _normalized_str(task.get("status")).lower()
    if status == "cancelled" or outcome_state == "cancelled":
        derived = "cancelled"
    elif status in {"done", "completed", "failed", "deferred"}:
        derived = "finished"
    elif status == "blocked":
        if (
            _normalized_str(task.get("completed_at"))
            or worker_result
            or _normalized_str(task.get("result_ready_at"))
            or _normalized_str(task.get("handoff_ready_at"))
        ):
            derived = "finished"
        else:
            derived = "finalizing"
    elif status in {"needs_approval", "pending_confirm"}:
        derived = "finalizing"
    elif status in {"running", "in_progress"}:
        derived = "running"
    elif status in {"queued", "pending", "dispatched"}:
        derived = "queued"
    else:
        derived = "planned"
    explicit = _normalized_choice(task.get("lifecycle_state"), LIFECYCLE_STATES)
    if explicit:
        if derived in FINAL_LIFECYCLE_STATES and explicit not in FINAL_LIFECYCLE_STATES:
            return derived
        return explicit
    return derived


def infer_handoff_state(
    task: dict[str, Any],
    lifecycle_state: str,
    outcome_state: str,
    worker_result: dict[str, Any] | None = None,
) -> str:
    if _normalized_str(task.get("delivered_at")):
        derived = "delivered"
        explicit = _normalized_choice(task.get("handoff_state"), HANDOFF_STATES)
        if explicit:
            return explicit
        return derived
    explicit_safe_summary = _normalized_str(task.get("user_safe_summary")) or _normalized_str(
        (worker_result or {}).get("user_safe_summary")
    )
    summary = explicit_safe_summary or _normalized_str(task.get("summary")) or _normalized_str((worker_result or {}).get("summary"))
    has_summary = bool(summary or _normalized_str(task.get("report_path")))
    if lifecycle_state in FINAL_LIFECYCLE_STATES:
        if outcome_state in READY_OUTCOME_STATES and (explicit_safe_summary or (has_summary and not _normalized_bool(task.get("review_required")))):
            derived = "user_safe_ready"
        elif outcome_state in READY_OUTCOME_STATES | {"failed"} and has_summary:
            derived = "internal_only"
        else:
            derived = "none"
    elif lifecycle_state in {"running", "finalizing"} and has_summary:
        derived = "internal_only"
    else:
        derived = "none"
    explicit = _normalized_choice(task.get("handoff_state"), HANDOFF_STATES)
    if explicit:
        if derived in {"internal_only", "user_safe_ready", "delivered"} and explicit == "none":
            return derived
        if explicit == "internal_only" and derived in {"user_safe_ready", "delivered"}:
            return derived
        return explicit
    return derived


def infer_blocked_on(task: dict[str, Any], outcome_state: str, artifacts: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("blocked_on"))
    if explicit:
        return explicit
    candidate = _normalized_str(artifacts.get("blocked_on"))
    if candidate:
        return candidate
    if outcome_state != "blocked":
        return ""
    recovery_action = _normalized_str(task.get("recovery_action")).lower()
    if "quota" in recovery_action:
        return "quota"
    return ""


def infer_blocked_reason(task: dict[str, Any], outcome_state: str, artifacts: dict[str, Any], worker_result: dict[str, Any] | None = None) -> str:
    explicit = _normalized_str(task.get("blocked_reason"))
    if explicit:
        return explicit
    candidate = _normalized_str(artifacts.get("blocked_reason"))
    if candidate:
        return candidate
    if outcome_state != "blocked":
        return ""
    risks = worker_result.get("risks") if isinstance(worker_result, dict) else []
    if isinstance(risks, list):
        for item in risks:
            text = _normalized_str(item)
            if text:
                return text
    return ""


def infer_deliverable_kind(task: dict[str, Any], lifecycle_state: str, outcome_state: str, handoff_state: str) -> str:
    explicit = _normalized_str(task.get("deliverable_kind"))
    if explicit:
        return explicit
    if lifecycle_state not in FINAL_LIFECYCLE_STATES:
        return "internal_progress"
    if outcome_state == "blocked":
        return "blocked_explanation" if handoff_state in {"user_safe_ready", "delivered"} else "internal_progress"
    if outcome_state == "partial":
        return "partial_answer"
    if outcome_state == "failed":
        return "failure_report"
    if outcome_state == "done":
        return "final_answer"
    return ""


def infer_user_safe_summary(task: dict[str, Any], handoff_state: str, worker_result: dict[str, Any] | None = None) -> str:
    explicit = _normalized_str(task.get("user_safe_summary")) or _normalized_str((worker_result or {}).get("user_safe_summary"))
    if explicit:
        return explicit
    if handoff_state not in {"user_safe_ready", "delivered"}:
        return ""
    return (
        _normalized_str((worker_result or {}).get("user_safe_summary"))
        or _normalized_str((worker_result or {}).get("summary"))
        or _normalized_str(task.get("summary"))
    )


def infer_result_ready_at(task: dict[str, Any], lifecycle_state: str, outcome_state: str, worker_result: dict[str, Any] | None = None) -> str:
    explicit = _normalized_str(task.get("result_ready_at"))
    if explicit:
        return explicit
    if lifecycle_state not in FINAL_LIFECYCLE_STATES or outcome_state == "pending":
        return ""
    if worker_result or _normalized_str(task.get("report_path")) or _normalized_str(task.get("summary")):
        return _normalized_str(task.get("completed_at")) or _normalized_str(task.get("updated_at"))
    return ""


def infer_handoff_ready_at(task: dict[str, Any], handoff_state: str, result_ready_at: str) -> str:
    explicit = _normalized_str(task.get("handoff_ready_at"))
    if explicit:
        return explicit
    if handoff_state not in {"user_safe_ready", "delivered"}:
        return ""
    return result_ready_at or _normalized_str(task.get("completed_at")) or _normalized_str(task.get("updated_at"))


def infer_observability_health(task: dict[str, Any], lifecycle_state: str, handoff_state: str) -> str:
    explicit = _normalized_str(task.get("observability_health"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route")).lower()
    runtime = _normalized_str(task.get("runtime")).lower()
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    spawn_execution = artifacts.get("spawn_execution", {}) if isinstance(artifacts.get("spawn_execution", {}), dict) else {}
    execution_backend = _normalized_str(artifacts.get("execution_backend")).lower()
    spawn_backend = _normalized_str(spawn_execution.get("backend")).lower()
    session_key = _normalized_str(task.get("session_key"))
    session_id = _normalized_str(task.get("session_id")) or _normalized_str(spawn_execution.get("session_id"))
    run_id = _normalized_str(task.get("run_id")) or _normalized_str(spawn_execution.get("run_id"))
    managed = infer_managed_by_octoclaw(task)
    native_session_backed = (execution_backend == "native_openclaw_agent" or spawn_backend == "native") and bool(session_id)
    if managed and route in {"runner", "spawn_single", "spawn_multi"} and not session_key and not native_session_backed:
        return "degraded_missing_session_key"
    if managed and runtime == "subagent" and lifecycle_state in {"running", "finished"} and not run_id and not native_session_backed:
        return "degraded_missing_run_id"
    if handoff_state in {"user_safe_ready", "delivered"} and route != "direct" and not session_key and not native_session_backed:
        return "degraded_missing_anchor"
    return "healthy"


def task_state_model(task: dict[str, Any]) -> dict[str, Any]:
    candidate = dict(task) if isinstance(task, dict) else {}
    artifacts = candidate.get("artifacts", {}) if isinstance(candidate.get("artifacts", {}), dict) else {}
    worker_result = _existing_worker_result(candidate, artifacts)
    if worker_result is None:
        worker_result = _final_worker_result(candidate, artifacts)
    outcome_state = infer_outcome_state(candidate, worker_result)
    lifecycle_state = infer_lifecycle_state(candidate, outcome_state, worker_result)
    handoff_state = infer_handoff_state(candidate, lifecycle_state, outcome_state, worker_result)
    result_ready_at = infer_result_ready_at(candidate, lifecycle_state, outcome_state, worker_result)
    return {
        "lifecycle_state": lifecycle_state,
        "outcome_state": outcome_state,
        "handoff_state": handoff_state,
        "blocked_on": infer_blocked_on(candidate, outcome_state, artifacts),
        "blocked_reason": infer_blocked_reason(candidate, outcome_state, artifacts, worker_result),
        "deliverable_kind": infer_deliverable_kind(candidate, lifecycle_state, outcome_state, handoff_state),
        "user_safe_summary": infer_user_safe_summary(candidate, handoff_state, worker_result),
        "result_ready_at": result_ready_at,
        "handoff_ready_at": infer_handoff_ready_at(candidate, handoff_state, result_ready_at),
        "observability_health": infer_observability_health(candidate, lifecycle_state, handoff_state),
    }


def task_is_final(task: dict[str, Any]) -> bool:
    return _normalized_choice(task.get("lifecycle_state"), LIFECYCLE_STATES) in FINAL_LIFECYCLE_STATES or task_state_model(task)["lifecycle_state"] in FINAL_LIFECYCLE_STATES


def task_is_recent_final(task: dict[str, Any]) -> bool:
    state = task_state_model(task)
    return state["lifecycle_state"] in FINAL_LIFECYCLE_STATES and state["outcome_state"] in READY_OUTCOME_STATES


def task_notification_state(task: dict[str, Any]) -> str:
    state = task_state_model(task)
    handoff_state = state["handoff_state"]
    if state["lifecycle_state"] in FINAL_LIFECYCLE_STATES:
        if state["outcome_state"] == "done":
            return "done" if handoff_state in {"user_safe_ready", "delivered"} else "done_internal"
        if state["outcome_state"] == "blocked":
            return "blocked_final" if handoff_state in {"user_safe_ready", "delivered"} else "blocked_internal"
        if state["outcome_state"] == "partial":
            return "partial_final" if handoff_state in {"user_safe_ready", "delivered"} else "partial_internal"
        if state["outcome_state"] == "failed":
            return "failed"
        if state["outcome_state"] == "cancelled":
            return "cancelled"
    status = _normalized_str(task.get("status")).lower()
    if status in {"running", "in_progress"}:
        return "running"
    if status in {"queued", "pending", "dispatched"}:
        return "dispatched"
    if status in {"blocked", "needs_approval", "pending_confirm"}:
        return "blocked"
    return status or "planned"


def task_queue_bucket(task: dict[str, Any]) -> str:
    state = task_state_model(task)
    if state["lifecycle_state"] in FINAL_LIFECYCLE_STATES:
        if state["outcome_state"] in READY_OUTCOME_STATES:
            return "recently_completed"
        return "final"
    if state["outcome_state"] == "blocked":
        return "blocked"
    if state["lifecycle_state"] in {"running", "finalizing"}:
        return "running"
    return "queued"


def normalize_task_record(task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {}

    normalized = dict(task)
    normalized["id"] = _normalized_str(normalized.get("id"))
    normalized["schema_version"] = TASK_RECORD_SCHEMA_VERSION
    normalized["title"] = infer_title(normalized)
    normalized["status"] = _normalized_str(normalized.get("status"))
    normalized["source"] = _normalized_str(normalized.get("source")) or "octoclaw"
    normalized["route"] = _normalized_str(normalized.get("route"))
    normalized["runtime"] = infer_runtime(normalized)
    normalized["executor"] = infer_executor(normalized)
    normalized["executor_type"] = infer_executor_type(normalized)
    normalized["task_kind"] = _normalized_str(normalized.get("task_kind"))
    work_type = infer_work_type(normalized)
    normalized["work_type"] = work_type
    normalized["phase"] = infer_phase(normalized, work_type)
    normalized["worker_pool"] = infer_worker_pool(normalized, work_type)
    normalized["protocol"] = _normalized_str(normalized.get("protocol")) or "normal"
    normalized["profile"] = _normalized_str(normalized.get("profile"))
    normalized["review_required"] = _normalized_bool(normalized.get("review_required"))
    normalized.pop("label", None)
    normalized.pop("legacy_label", None)
    normalized["owner"] = _normalized_str(normalized.get("owner"))
    normalized["session_key"] = _normalized_str(normalized.get("session_key"))
    normalized["session_origin"] = _normalized_str(normalized.get("session_origin")) or infer_session_origin(normalized.get("session_key"))
    session_binding = session_binding_from_route(normalized["session_key"], normalized.get("resolved_target") if isinstance(normalized.get("resolved_target"), dict) else None)
    normalized["session_target"] = _normalized_str(normalized.get("session_target")) or _normalized_str(session_binding.get("target"))
    normalized["session_thread_id"] = _normalized_str(normalized.get("session_thread_id")) or _normalized_str(session_binding.get("thread_id"))
    normalized["session_thread_key"] = _normalized_str(normalized.get("session_thread_key")) or _normalized_str(session_binding.get("thread_key"))
    normalized["agent_id"] = infer_agent_id(normalized)
    managed_by_octoclaw = infer_managed_by_octoclaw(normalized)
    normalized["managed_by_octoclaw"] = managed_by_octoclaw
    normalized["agent_namespace"] = infer_agent_namespace(normalized, managed_by_octoclaw)
    normalized["model_band"] = infer_model_band(normalized, work_type)
    normalized.pop("tier", None)
    normalized["model"] = _normalized_str(normalized.get("model"))
    normalized["summary"] = _normalized_str(normalized.get("summary"))
    normalized["task_description"] = _normalized_str(normalized.get("task_description"))
    normalized["parent_id"] = _normalized_str(normalized.get("parent_id"))
    normalized["deps"] = _normalized_list(normalized.get("deps"))
    normalized["child_ids"] = _normalized_list(normalized.get("child_ids"))
    normalized["report_path"] = _normalized_str(normalized.get("report_path"))
    normalized["context_path"] = _normalized_str(normalized.get("context_path"))
    normalized["context_summary"] = _normalized_str(normalized.get("context_summary"))
    normalized["files_changed"] = _normalized_list(normalized.get("files_changed"))
    normalized["spawned_at"] = _normalized_str(normalized.get("spawned_at"))
    normalized["started_at"] = _normalized_str(normalized.get("started_at"))
    normalized["completed_at"] = _normalized_str(normalized.get("completed_at"))
    normalized["updated_at"] = _normalized_str(normalized.get("updated_at"))
    normalized["session_id"] = _normalized_str(normalized.get("session_id"))
    normalized["run_id"] = _normalized_str(normalized.get("run_id"))
    normalized["session_status"] = _normalized_str(normalized.get("session_status"))
    normalized["last_observed_at"] = _normalized_str(normalized.get("last_observed_at"))
    normalized["recovery_action"] = _normalized_str(normalized.get("recovery_action"))
    retry_count = normalized.get("retry_count")
    normalized["retry_count"] = int(retry_count or 0) if str(retry_count or "").strip() else 0
    normalized["expected_done_at"] = _normalized_str(normalized.get("expected_done_at"))
    artifacts = merge_artifacts(normalized)
    delegated_materialization = normalize_delegated_materialization(
        artifacts.get("delegated_materialization") if isinstance(artifacts.get("delegated_materialization"), dict) else normalized.get("delegated_materialization"),
        lane=normalized["route"],
    )
    capability_failure = normalize_capability_bound_failure(
        artifacts.get("capability_failure") if isinstance(artifacts.get("capability_failure"), dict) else normalized.get("capability_failure"),
        lane=normalized["route"],
    )
    normalized["delegated_materialization"] = delegated_materialization
    normalized["capability_failure"] = capability_failure
    if delegated_materialization.get("lane") or delegated_materialization.get("kind"):
        artifacts["delegated_materialization"] = delegated_materialization
    if capability_failure.get("reason"):
        artifacts["capability_failure"] = capability_failure
    worker_result = _existing_worker_result(normalized, artifacts)
    if worker_result is None:
        worker_result = _final_worker_result(normalized, artifacts)
    if worker_result:
        artifacts["worker_result"] = worker_result
    taskflow = _taskflow_binding({**normalized, "artifacts": artifacts})
    normalized["openclaw_taskflow"] = taskflow
    normalized["openclaw_taskflow_backend"] = _normalized_str(normalized.get("openclaw_taskflow_backend") or taskflow.get("backend"))
    normalized["openclaw_taskflow_state"] = _normalized_str(normalized.get("openclaw_taskflow_state") or taskflow.get("binding_state"))
    normalized["openclaw_task_runtime"] = _normalized_str(normalized.get("openclaw_task_runtime") or taskflow.get("task_runtime"))
    normalized["openclaw_flow_runtime"] = _normalized_str(normalized.get("openclaw_flow_runtime") or taskflow.get("flow_runtime"))
    normalized["openclaw_taskflow_sync_mode"] = _normalized_str(normalized.get("openclaw_taskflow_sync_mode") or taskflow.get("sync_mode"))
    normalized["openclaw_taskflow_substrate_state"] = _normalized_str(normalized.get("openclaw_taskflow_substrate_state") or taskflow.get("substrate_state"))
    substrate_revision = normalized.get("openclaw_taskflow_substrate_revision")
    if str(substrate_revision or "").strip():
        normalized["openclaw_taskflow_substrate_revision"] = _normalized_int(substrate_revision)
    else:
        normalized["openclaw_taskflow_substrate_revision"] = _normalized_int(taskflow.get("substrate_revision"))
    normalized["openclaw_task_id"] = _normalized_str(normalized.get("openclaw_task_id") or taskflow.get("task_id"))
    normalized["openclaw_flow_id"] = _normalized_str(normalized.get("openclaw_flow_id") or taskflow.get("flow_id"))
    normalized["openclaw_flow_kind"] = _normalized_str(normalized.get("openclaw_flow_kind") or taskflow.get("flow_kind"))
    normalized["openclaw_native_binding_state"] = _normalized_str(normalized.get("openclaw_native_binding_state") or taskflow.get("native_binding_state"))
    normalized["openclaw_native_status"] = _normalized_str(normalized.get("openclaw_native_status") or taskflow.get("native_status"))
    normalized["openclaw_native_runtime"] = _normalized_str(normalized.get("openclaw_native_runtime") or taskflow.get("native_runtime"))
    normalized["openclaw_native_seen_at"] = _normalized_str(normalized.get("openclaw_native_seen_at") or taskflow.get("native_seen_at"))
    native_match_score = normalized.get("openclaw_native_match_score")
    if str(native_match_score or "").strip():
        normalized["openclaw_native_match_score"] = int(native_match_score or 0)
    else:
        inferred_match_score = taskflow.get("native_match_score")
        normalized["openclaw_native_match_score"] = int(inferred_match_score or 0) if str(inferred_match_score or "").strip() else 0
    normalized.update(task_state_model({**normalized, "artifacts": artifacts}))
    normalized["artifacts"] = artifacts
    explicit_ownership = normalized.get("ownership") if isinstance(normalized.get("ownership"), dict) else {}
    derived_ownership = ownership_snapshot(normalized)
    normalized["ownership"] = {**derived_ownership, **{k: v for k, v in explicit_ownership.items() if v not in (None, "", [], {})}}
    explicit_resume = normalized.get("session_resume") if isinstance(normalized.get("session_resume"), dict) else {}
    derived_resume = session_resume_snapshot(normalized)
    normalized["session_resume"] = {**derived_resume, **{k: v for k, v in explicit_resume.items() if v not in (None, "", [], {})}}
    normalized["checklist"] = resolve_task_checklist(normalized)
    event_snapshot = task_event_snapshot(normalized["id"]) if normalized["id"] else {}
    normalized["task_event_summary"] = {
        "task_event_count": int(event_snapshot.get("task_event_count", 0) or 0),
        "kind_counts": event_snapshot.get("kind_counts", {}) if isinstance(event_snapshot.get("kind_counts", {}), dict) else {},
        "degraded_event_count": int(event_snapshot.get("degraded_event_count", 0) or 0),
        "latest_kind": _normalized_str(event_snapshot.get("latest_kind")),
        "latest_time": _normalized_str(event_snapshot.get("latest_time")),
    }
    normalized["task_events_preview"] = event_snapshot.get("preview", []) if isinstance(event_snapshot.get("preview", []), list) else []
    return normalized


def normalize_task_records(tasks: list[Any]) -> list[dict[str, Any]]:
    return [normalize_task_record(task) for task in tasks if isinstance(task, dict)]
