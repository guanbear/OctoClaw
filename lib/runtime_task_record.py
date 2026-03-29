#!/usr/bin/env python3
"""Shared runtime task record helpers for OctoClaw."""

from __future__ import annotations

from typing import Any

try:
    from octopus_config import infer_session_origin
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import infer_session_origin

try:
    from worker_taxonomy import resolve_executor, resolve_model_band, resolve_phase, resolve_work_type, resolve_worker_pool
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.worker_taxonomy import resolve_executor, resolve_model_band, resolve_phase, resolve_work_type, resolve_worker_pool

try:
    from runtime_protocol import normalize_worker_result
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_protocol import normalize_worker_result


TASK_RECORD_SCHEMA_VERSION = "octoclaw.runtime_task.record/v1"


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
    worker_result = _final_worker_result(normalized, artifacts)
    if worker_result:
        artifacts["worker_result"] = worker_result
    normalized["artifacts"] = artifacts
    return normalized


def normalize_task_records(tasks: list[Any]) -> list[dict[str, Any]]:
    return [normalize_task_record(task) for task in tasks if isinstance(task, dict)]
